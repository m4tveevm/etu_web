import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { readConfig, allowed } from '../src/config.mjs';
import { SESSION_COOKIE, TRANSACTION_COOKIE, seal, open } from '../src/cookies.mjs';
import { createOidc } from '../src/oidc.mjs';
import { createCloud, requestPath, MAX_FILE_BYTES } from '../src/cloud.mjs';
import { createApp } from '../src/app.mjs';

const issuer = 'https://id.example.invalid';
const origin = 'https://labs.example.invalid';
const releaseId = 'a'.repeat(40);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const baseEnv = () => ({ PUBLIC_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'etu-web',
  OIDC_CLIENT_SECRET: 'synthetic-test-secret', GATE_COOKIE_KEY: randomBytes(32).toString('base64url'),
  OIDC_ALLOWED_SUBJECTS: JSON.stringify([{ issuer, sub: 'owner-sub' }]), STATIC_BUCKET: 'test-private',
  RELEASE_ID: releaseId, RELEASE_MANIFEST_SHA256: 'b'.repeat(64),
  QUOTE_FUNCTION_URL: 'https://functions.yandexcloud.net/testfunction?tag=release-test' });
const config = () => readConfig(baseEnv());
const pair = (cookie) => cookie.split(';')[0];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json' } });
const metadata = { issuer, authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`, userinfo_endpoint: `${issuer}/oauth/userinfo`,
  revocation_endpoint: `${issuer}/oauth/revoke`, jwks_uri: `${issuer}/.well-known/jwks.json`,
  response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
  id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'] };
const user = { sub: 'owner-sub', client_id: 'etu-web', master_flags: { status: 'active', banned: false, suspended: false } };

async function request(app, url, options = {}) {
  let status, headers, bytes;
  await app({ url, method: options.method || 'GET', headers: options.headers || {} }, {
    writeHead(code, values) { status = code; headers = values; },
    end(body) { bytes = body; },
  });
  return { status, headers, bytes, text: bytes?.toString() || '' };
}

test('configuration and access policy deny missing, malformed and unmatched identities', () => {
  assert.equal(readConfig({}), null);
  const env = baseEnv();
  assert.equal(readConfig({ ...env, PUBLIC_ORIGIN: 'http://labs.example.invalid' }), null);
  assert.equal(readConfig({ ...env, OIDC_ALLOWED_SUBJECTS: '["owner-sub"]' }), null);
  assert.equal(readConfig({ ...env, GATE_COOKIE_KEY: 'short' }), null);
  const empty = readConfig({ ...env, OIDC_ALLOWED_SUBJECTS: '[]' });
  assert.equal(allowed(empty, issuer, 'owner-sub'), false);
  assert.equal(allowed(config(), issuer, 'owner-sub'), true);
  assert.equal(allowed(config(), issuer, 'OWNER-SUB'), false);
  assert.equal(allowed(config(), 'https://other.invalid', 'owner-sub'), false);
  assert.equal(readConfig({ ...env, QUOTE_FUNCTION_URL: 'https://evil.invalid/function?tag=x' }), null);
});

test('cookies are confidential, authenticated, host-only, expire and reject duplicates/oversize', () => {
  const c = config();
  const cookie = seal(c, SESSION_COOKIE, { accessToken: 'never-plaintext' }, 60, 1_000_000);
  assert.match(cookie, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=60$/);
  assert.doesNotMatch(cookie, /never-plaintext|Domain=/);
  assert.equal(open(c, SESSION_COOKIE, pair(cookie), 1_001_000).accessToken, 'never-plaintext');
  assert.equal(open(c, SESSION_COOKIE, pair(cookie), 1_060_000), null);
  assert.equal(open(c, TRANSACTION_COOKIE, pair(cookie).replace(SESSION_COOKIE, TRANSACTION_COOKIE), 1_001_000), null);
  assert.equal(open({ ...c, origin: 'https://other.invalid' }, SESSION_COOKIE, pair(cookie), 1_001_000), null);
  assert.equal(open(c, SESSION_COOKIE, `${pair(cookie)}; ${pair(cookie)}`, 1_001_000), null);
  const tampered = pair(cookie).slice(0, -5) + 'AAAAA';
  assert.equal(open(c, SESSION_COOKIE, tampered, 1_001_000), null);
  assert.throws(() => seal(c, SESSION_COOKIE, { accessToken: 'x'.repeat(4000) }, 60), /cookie_too_large/);
});

test('OIDC verifies real RS256/JWKS signatures, issuer, audience, expiry, nonce and token binding', async (t) => {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  async function token(claims = {}, header = {}) {
    return new SignJWT({ iss: issuer, aud: 'etu-web', sub: 'owner-sub', iat: now, exp: now + 600,
      nonce: 'expected-nonce', ...claims }).setProtectedHeader({ alg: 'RS256', kid: 'test-key', ...header }).sign(keys.privateKey);
  }
  let tokenResponse;
  let exchangeBody;
  let discovered = metadata;
  const fetcher = async (url, init) => {
    url = String(url);
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/openid-configuration')) return json(discovered);
    if (url.endsWith('/jwks.json')) return json({ keys: [jwk] });
    if (url.endsWith('/token')) {
      exchangeBody = new URLSearchParams(init.body);
      assert.match(init.headers.authorization, /^Basic /);
      return json(tokenResponse);
    }
    if (url.endsWith('/userinfo')) return json(user);
    throw new Error('unexpected URL');
  };
  const oidc = createOidc(config(), fetcher);
  assert.equal((await oidc.verify(await token(), 'expected-nonce')).sub, 'owner-sub');
  for (const [name, claims] of [ ['issuer', { iss: 'https://wrong.invalid' }], ['audience', { aud: 'wrong' }],
    ['expiry', { exp: now - 30 }], ['future iat', { iat: now + 600 }], ['subject', { sub: '' }],
    ['azp', { aud: ['etu-web', 'another'], azp: 'another' }]]) {
    await t.test(`reject ${name}`, async () => assert.rejects(oidc.verify(await token(claims), 'expected-nonce')));
  }
  await assert.rejects(oidc.verify(await token(), 'wrong-nonce'));
  await assert.rejects(oidc.verify(await token({}, { kid: 'unknown-key' }), 'expected-nonce'));
  const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
  await assert.rejects(oidc.verify(unsigned));
  const signed = await token();
  await assert.rejects(oidc.verify(signed.slice(0, -30) + 'A'.repeat(30)));
  tokenResponse = { token_type: 'Bearer', expires_in: 1800, id_token: await token(), access_token: await token({ exp: now + 1700 }) };
  const session = await oidc.exchange('single-code', 'original-verifier', 'expected-nonce');
  assert.equal(exchangeBody.get('redirect_uri'), `${origin}/auth/callback`);
  assert.equal(exchangeBody.get('code_verifier'), 'original-verifier');
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');
  assert.ok(session.ttl <= 1700);
  tokenResponse.access_token = await token({ sub: 'other-sub' });
  await assert.rejects(oidc.exchange('code', 'verifier', 'expected-nonce'), /subject_mismatch/);
  discovered = { ...metadata, jwks_uri: 'https://evil.invalid/jwks' };
  await assert.rejects(createOidc(config(), fetcher).metadata(), /discovery_endpoint/);
});

function appFixture(overrides = {}) {
  const c = config();
  const events = [];
  const calls = { userinfo: 0, object: 0, quote: 0, revoke: 0, exchange: 0 };
  const used = new Set();
  const oidc = {
    metadata: async () => metadata,
    exchange: async (code) => { calls.exchange++; if (used.has(code)) throw new Error('code_used'); used.add(code);
      return { issuer, sub: 'owner-sub', accessToken: 'synthetic-access', ttl: 600 }; },
    userinfo: async () => { calls.userinfo++; return user; },
    revoke: async () => { calls.revoke++; }, ...overrides,
  };
  const cloud = {
    object: async () => { calls.object++; return { bytes: Buffer.from('private-file'), contentType: 'text/html' }; },
    quote: async () => { calls.quote++; return { text: 'test' }; },
  };
  const app = createApp({ config: c, oidc, cloud, audit: (event) => events.push(event) });
  const sessionCookie = pair(seal(c, SESSION_COOKIE, { issuer, sub: 'owner-sub', accessToken: 'synthetic-access' }, 600));
  return { c, app, calls, events, sessionCookie };
}

test('login binds random state+nonce+S256 PKCE and callback clears transaction', async () => {
  const { app, c, calls } = appFixture();
  const start = await request(app, '/auth/login?returnTo=/lab-02/index.html');
  assert.equal(start.status, 303);
  const target = new URL(start.headers.location);
  const transactionCookie = pair(start.headers['set-cookie'][0]);
  const transaction = open(c, TRANSACTION_COOKIE, transactionCookie);
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(target.searchParams.get('scope'), 'openid');
  assert.equal(target.searchParams.get('code_challenge'), createHash('sha256').update(transaction.verifier).digest('base64url'));
  assert.equal(target.searchParams.get('nonce'), transaction.nonce);
  assert.equal(target.searchParams.get('state'), transaction.state);
  assert.equal(transaction.exp - transaction.iat, 300);
  const callbackUrl = `/auth/callback?code=test-code&state=${transaction.state}`;
  const callback = await request(app, callbackUrl, { headers: { cookie: transactionCookie } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.location, '/lab-02/index.html');
  assert.match(callback.headers['set-cookie'][0], /Max-Age=0$/);
  assert.equal(calls.userinfo, 1);
  const replay = await request(app, callbackUrl, { headers: { cookie: transactionCookie } });
  assert.equal(replay.status, 503); // ID rejects a code that was consumed on the first callback.
  const noCookie = await request(app, callbackUrl);
  assert.equal(noCookie.status, 400);
});

test('callback rejects state mismatch, duplicate parameters, errors and alien users', async () => {
  const { app, c, calls } = appFixture();
  const cookie = pair(seal(c, TRANSACTION_COOKIE, { state: 'expected', nonce: 'n', verifier: 'v', returnTo: '/' }, 300));
  for (const query of ['code=x&state=wrong', 'code=x&state=expected&state=expected',
    'code=x&code=y&state=expected', 'error=access_denied&state=expected', 'code=x&state=expected&iss=evil']) {
    const result = await request(app, `/auth/callback?${query}`, { headers: { cookie } });
    assert.equal(result.status, 400);
    assert.ok(result.headers['set-cookie'].every((value) => value.includes('Max-Age=0')));
  }
  assert.equal(calls.exchange, 0);
  const stranger = appFixture({ exchange: async () => ({ issuer, sub: 'stranger', accessToken: 'stranger-token', ttl: 600 }) });
  const tx = pair(seal(stranger.c, TRANSACTION_COOKIE, { state: 'expected', nonce: 'n', verifier: 'v', returnTo: '/' }, 300));
  const result = await request(stranger.app, '/auth/callback?code=x&state=expected', { headers: { cookie: tx } });
  assert.equal(result.status, 403);
  assert.equal(stranger.calls.revoke, 1);
  assert.equal(stranger.calls.object, 0);
});

test('login assets render without a session but expose no private data or broader public route', async () => {
  const { app, calls } = appFixture();
  const page = await request(app, '/');
  assert.equal(page.status, 401);
  assert.match(page.text, /href="\/auth\/login\.css"/);
  assert.match(page.text, /href="\/auth\/login"/);
  assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
  const css = await request(app, '/auth/login.css');
  assert.equal(css.status, 200);
  assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
  assert.ok(css.bytes.length > 0);
  const head = await request(app, '/auth/login.css', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], css.bytes.length);
  assert.equal(head.bytes, undefined);
  assert.equal((await request(app, '/auth/login.css', { method: 'POST' })).status, 405);
  for (const path of ['/auth/login.css/extra', '/auth/login.css.map', '/lab-01/style.css', '/lab-02/report/report.pdf', '/api/v1/quote']) {
    assert.equal((await request(app, path)).status, 401);
  }
  assert.equal(calls.object, 0);
  assert.equal(calls.quote, 0);
  assert.equal(calls.userinfo, 0);
});

test('anonymous traffic never fetches private data and each authorised request checks live UserInfo', async () => {
  const { app, calls, sessionCookie } = appFixture();
  assert.equal((await request(app, '/lab-02/report/report.pdf')).status, 401);
  assert.equal((await request(app, '/api/v1/quote')).status, 401);
  assert.equal(calls.object, 0);
  assert.equal(calls.quote, 0);
  const first = await request(app, '/', { headers: { cookie: sessionCookie } });
  assert.equal(first.status, 200);
  assert.match(first.headers['cache-control'], /no-store/);
  assert.doesNotMatch(first.headers['content-security-policy'], /unsafe-inline/);
  assert.equal((await request(app, '/lab-02/index.html', { headers: { cookie: sessionCookie } })).status, 200);
  assert.equal((await request(app, '/api/v1/quote', { headers: { cookie: sessionCookie } })).status, 200);
  assert.equal(calls.userinfo, 3);
  assert.equal(calls.object, 2);
  assert.equal(calls.quote, 1);
  const quoteHead = await request(app, '/api/v1/quote', { method: 'HEAD', headers: { cookie: sessionCookie } });
  assert.equal(quoteHead.status, 405);
  assert.equal(quoteHead.headers.allow, 'GET');
  assert.equal(calls.quote, 1);
  const head = await request(app, '/', { method: 'HEAD', headers: { cookie: sessionCookie } });
  assert.equal(head.bytes, undefined);
  assert.equal(head.headers['content-length'], 12);
});

test('only authenticated lab HTML can be embedded by its own host', async () => {
  const { app, calls, sessionCookie } = appFixture();
  for (const path of ['/view/lab-01/', '/lab-01/']) {
    const anonymous = await request(app, path);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers['x-frame-options'], 'DENY');
  }
  assert.equal(calls.object, 0);
  const lab = await request(app, '/lab-01/', { headers: { cookie: sessionCookie } });
  assert.equal(lab.status, 200);
  assert.equal(lab.headers['x-frame-options'], 'SAMEORIGIN');
  assert.match(lab.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.doesNotMatch(lab.headers['content-security-policy'], /unsafe-inline/);
  for (const path of ['/view/lab-01/', '/lab-01/report/report.pdf', '/']) {
    const other = await request(app, path, { headers: { cookie: sessionCookie } });
    assert.equal(other.headers['x-frame-options'], 'DENY');
    assert.match(other.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
});

test('callback revokes a newly issued token if live UserInfo fails', async () => {
  const { app, c, calls } = appFixture({ userinfo: async () => { throw new Error('identity_disabled'); } });
  const cookie = pair(seal(c, TRANSACTION_COOKIE, { state: 'expected', nonce: 'n', verifier: 'v', returnTo: '/' }, 300));
  const response = await request(app, '/auth/callback?code=new-code&state=expected', { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.equal(calls.revoke, 1);
  assert.ok(response.headers['set-cookie'].every((value) => value.includes('Max-Age=0')));
});

test('UserInfo must match subject/client and must report an active identity', async () => {
  let body = user;
  const oidc = createOidc(config(), async (url) => String(url).endsWith('/openid-configuration') ? json(metadata) : json(body));
  const session = { sub: 'owner-sub', accessToken: 'synthetic' };
  await oidc.userinfo(session);
  for (const altered of [{ ...user, sub: 'other' }, { ...user, client_id: 'another-client' },
    { ...user, master_flags: {} }, { ...user, master_flags: { ...user.master_flags, banned: true } }]) {
    body = altered;
    await assert.rejects(oidc.userinfo(session), /invalid_userinfo/);
  }
});

test('quote forwarding uses IAM and the shared strict response contract', async () => {
  let payload = { schemaVersion: 1, id: 'test-quote', text: 'Тестовая цитата.', language: 'ru',
    attribution: { speaker: 'Тест', work: 'Тест', sourceUrl: 'https://example.invalid/source' } };
  const c = config();
  const cloud = createCloud(c, async (url, init) => {
    if (url.startsWith('http://169.254.169.254/')) return json({ access_token: 'synthetic-iam', expires_in: 3600 });
    assert.equal(url, c.quoteUrl);
    assert.equal(init.headers.authorization, 'Bearer synthetic-iam');
    return json(payload);
  });
  assert.equal((await cloud.quote()).id, 'test-quote');
  payload = { ...payload, unexpected: true };
  await assert.rejects(cloud.quote(), /quote_schema/);
});

test('revoked token and ID outage fail closed before reading an object or quote', async () => {
  const { app, calls, sessionCookie } = appFixture({ userinfo: async () => { throw new Error('revoked_or_unavailable'); } });
  for (const path of ['/', '/api/v1/quote']) {
    const result = await request(app, path, { headers: { cookie: sessionCookie } });
    assert.equal(result.status, 401);
    assert.match(result.headers['set-cookie'][0], /Max-Age=0$/);
  }
  assert.equal(calls.object, 0);
  assert.equal(calls.quote, 0);
});

test('logout requires same-origin POST and clears cookies even if revocation fails', async () => {
  const { app, sessionCookie, events } = appFixture({ revoke: async () => { throw new Error('offline'); } });
  assert.equal((await request(app, '/auth/logout')).status, 405);
  assert.equal((await request(app, '/auth/logout', { method: 'POST', headers: { origin: 'https://evil.invalid' } })).status, 403);
  const result = await request(app, '/auth/logout', { method: 'POST', headers: { origin, cookie: sessionCookie } });
  assert.equal(result.status, 303);
  assert.ok(result.headers['set-cookie'].every((value) => value.includes('Max-Age=0')));
  assert.ok(events.includes('revocation_failed'));
  assert.doesNotMatch(JSON.stringify(events), /synthetic-access|owner-sub/);
});

test('unconfigured or empty policy gate denies traffic without calling upstream', async () => {
  const unknown = createApp({ config: null });
  assert.equal((await request(unknown, '/')).status, 503);
  assert.equal((await request(unknown, '/healthz')).status, 503);
  const empty = createApp({ config: { ...config(), allowlist: [] } });
  assert.equal((await request(empty, '/auth/login')).status, 503);
});

test('object paths reject traversal, encoded delimiters, absolute URLs and malformed escapes', () => {
  for (const path of ['/../private', '/lab-02/%2e%2e/report.pdf', '//evil.invalid/', '/%252e%252e/x',
    '/lab-02\\secret', '/%00', '/%ZZ', 'https://evil.invalid/a']) assert.equal(requestPath(path), null, path);
  assert.equal(requestPath('/'), 'index.html');
  assert.equal(requestPath('/lab-02/'), 'lab-02/index.html');
});

test('private object reader authenticates with metadata IAM and checks manifest allowlist/hash/size', async () => {
  const bytes = Buffer.from('<h1>private</h1>');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, releaseId, files: [
    { path: 'index.html', sha256: sha(bytes), size: bytes.length, contentType: 'text/html; charset=utf-8' }] }));
  const c = { ...config(), manifestSha256: sha(manifest) };
  let objectReads = 0, metadataReads = 0;
  let body = bytes;
  const fetcher = async (url, init) => {
    if (url.startsWith('http://169.254.169.254/')) {
      metadataReads++;
      assert.equal(init.headers['Metadata-Flavor'], 'Google');
      return json({ access_token: 'synthetic-iam', expires_in: 3600 });
    }
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer synthetic-iam');
    assert.ok(url.startsWith(`https://storage.yandexcloud.net/test-private/releases/${releaseId}/${c.manifestSha256}/`));
    if (url.endsWith('/manifest.json')) return new Response(manifest);
    objectReads++;
    return new Response(body);
  };
  const cloud = createCloud(c, fetcher);
  assert.equal((await cloud.object('index.html')).bytes.toString(), bytes.toString());
  assert.equal(await cloud.object('secret.env'), null);
  assert.equal(await cloud.object('../index.html'), null);
  assert.equal(objectReads, 1);
  assert.equal(metadataReads, 1);
  body = Buffer.from('corrupted');
  await assert.rejects(cloud.object('index.html'), /object_digest/);
  const wrongDigestFetch = async (url, init) => url.startsWith('http://169.254.169.254/')
    ? fetcher(url, init) : new Response(manifest);
  await assert.rejects(createCloud({ ...c, manifestSha256: '0'.repeat(64) }, wrongDigestFetch).loadManifest(), /manifest_digest/);
});

test('binary object budget admits the lossless image and rejects larger manifests/streams', async () => {
  assert.equal(MAX_FILE_BYTES, 2_200_000);
  const image = Buffer.alloc(2_025_528, 7);
  let declaredSize = image.length;
  let bytes = image;
  const create = () => {
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, releaseId, files: [
      { path: 'index.html', sha256: sha(image), size: declaredSize, contentType: 'image/webp' }] }));
    return createCloud({ ...config(), manifestSha256: sha(manifest) }, async (url) => {
      if (url.startsWith('http://169.254.169.254/')) return json({ access_token: 'synthetic-iam', expires_in: 3600 });
      return new Response(url.endsWith('/manifest.json') ? manifest : bytes);
    });
  };
  assert.equal((await create().object('index.html')).bytes.length, image.length);
  bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  await assert.rejects(create().object('index.html'), /response_too_large/);
  declaredSize = MAX_FILE_BYTES + 1;
  await assert.rejects(create().loadManifest(), /manifest_entry/);
});
