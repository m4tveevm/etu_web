const httpsOrigin = (raw) => {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password) {
    throw new Error('invalid_origin');
  }
  return raw;
};

export function readConfig(env) {
  try {
    const origin = httpsOrigin(env.PUBLIC_ORIGIN);
    const issuer = httpsOrigin(env.OIDC_ISSUER);
    const clientId = env.OIDC_CLIENT_ID;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId || '') || !env.OIDC_CLIENT_SECRET) throw new Error();
    if (!/^[A-Za-z0-9_-]{43}$/.test(env.GATE_COOKIE_KEY || '')) throw new Error();
    const cookieKey = Buffer.from(env.GATE_COOKIE_KEY, 'base64url');
    if (cookieKey.length !== 32 || cookieKey.toString('base64url') !== env.GATE_COOKIE_KEY) throw new Error();
    const allowlist = JSON.parse(env.OIDC_ALLOWED_SUBJECTS || '[]');
    if (!Array.isArray(allowlist) || allowlist.length > 100 || allowlist.some((item) =>
      !item || item.issuer !== issuer || typeof item.sub !== 'string' || !item.sub || item.sub.length > 256)) throw new Error();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.STATIC_BUCKET || '')) throw new Error();
    if (!/^[a-f0-9]{40}$/.test(env.RELEASE_ID || '')) throw new Error();
    if (!/^[a-f0-9]{64}$/.test(env.RELEASE_MANIFEST_SHA256 || '')) throw new Error();
    let quoteUrl;
    if (env.QUOTE_FUNCTION_URL) {
      quoteUrl = new URL(env.QUOTE_FUNCTION_URL);
      if (quoteUrl.protocol !== 'https:' || quoteUrl.hostname !== 'functions.yandexcloud.net'
        || quoteUrl.username || quoteUrl.password || quoteUrl.hash || quoteUrl.port
        || !/^\/[a-z0-9]+$/.test(quoteUrl.pathname)
        || [...quoteUrl.searchParams.keys()].some((key) => key !== 'tag')
        || quoteUrl.searchParams.getAll('tag').length !== 1
        || !/^[A-Za-z0-9_-]+$/.test(quoteUrl.searchParams.get('tag'))) throw new Error();
    }
    return Object.freeze({ origin, issuer, clientId, clientSecret: env.OIDC_CLIENT_SECRET,
      cookieKey, allowlist, bucket: env.STATIC_BUCKET, releaseId: env.RELEASE_ID,
      manifestSha256: env.RELEASE_MANIFEST_SHA256, quoteUrl: quoteUrl?.href,
      callback: `${origin}/auth/callback` });
  } catch {
    // Never include environment values: they contain credentials.
    return null;
  }
}

export function allowed(config, issuer, sub) {
  return typeof sub === 'string' && config.allowlist.some((item) => item.issuer === issuer && item.sub === sub);
}
