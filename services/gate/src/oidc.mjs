import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { jsonRequest } from './http.mjs';

export function createOidc(config, fetcher = fetch) {
  let discovery;
  let cachedAt = 0;
  let keys;
  const authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`;

  async function metadata() {
    if (discovery && Date.now() - cachedAt < 300_000) return discovery;
    const data = await jsonRequest(fetcher, `${config.issuer}/.well-known/openid-configuration`);
    if (data.issuer !== config.issuer || !data.response_types_supported?.includes('code')
      || !data.code_challenge_methods_supported?.includes('S256')
      || !data.id_token_signing_alg_values_supported?.includes('RS256')
      || !data.token_endpoint_auth_methods_supported?.includes('client_secret_basic')) throw new Error('discovery_contract');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'revocation_endpoint', 'jwks_uri']) {
      const url = new URL(data[field]);
      if (url.origin !== config.issuer || url.username || url.password || url.hash || url.search) throw new Error('discovery_endpoint');
    }
    if (!keys || discovery?.jwks_uri !== data.jwks_uri) {
      keys = createRemoteJWKSet(new URL(data.jwks_uri), {
        timeoutDuration: 8000,
        [customFetch]: (url, options) => fetcher(url, { ...options, redirect: 'error' }),
      });
    }
    discovery = data;
    cachedAt = Date.now();
    return data;
  }

  async function verify(token, nonce) {
    await metadata();
    const { payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.clientId,
      algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp'], clockTolerance: 5 });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 256
      || !Number.isSafeInteger(payload.iat) || payload.iat > Math.floor(Date.now() / 1000) + 5
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
      || (payload.azp !== undefined && payload.azp !== config.clientId)
      || (nonce !== undefined && payload.nonce !== nonce)) throw new Error('invalid_claims');
    return payload;
  }

  async function exchange(code, verifier, nonce) {
    const meta = await metadata();
    const token = await jsonRequest(fetcher, meta.token_endpoint, { method: 'POST',
      headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code,
        redirect_uri: config.callback, code_verifier: verifier }).toString() });
    if (token.token_type !== 'Bearer' || typeof token.access_token !== 'string'
      || typeof token.id_token !== 'string' || token.access_token.length > 8192
      || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('invalid_tokens');
    const identity = await verify(token.id_token, nonce);
    const access = await verify(token.access_token);
    if (identity.sub !== access.sub) throw new Error('subject_mismatch');
    const ttl = Math.min(1800, Math.floor(token.expires_in), access.exp - Math.floor(Date.now() / 1000));
    if (ttl < 1) throw new Error('expired_access');
    return { accessToken: token.access_token, sub: identity.sub, issuer: config.issuer, ttl };
  }

  async function userinfo(session) {
    const meta = await metadata();
    const user = await jsonRequest(fetcher, meta.userinfo_endpoint, {
      headers: { authorization: `Bearer ${session.accessToken}` } });
    if (user.sub !== session.sub || user.client_id !== config.clientId
      || user.master_flags?.status !== 'active' || user.master_flags?.banned !== false
      || user.master_flags?.suspended !== false) throw new Error('invalid_userinfo');
    return user;
  }

  async function revoke(accessToken) {
    const meta = await metadata();
    const response = await fetcher(meta.revocation_endpoint, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(8000), headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken, token_type_hint: 'access_token' }).toString() });
    if (!response.ok) throw new Error('revoke_failed');
    await response.body?.cancel();
  }

  return { metadata, exchange, userinfo, revoke, verify };
}
