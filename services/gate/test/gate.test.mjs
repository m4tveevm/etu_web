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

function appFixture(overrides = {}, options = {}) {
  const c = options.config || config();
  const events = [];
  const calls = { userinfo: 0, object: 0, quote: 0, revoke: 0, exchange: 0 };
  const objectPaths = [];
  const used = new Set();
  const oidc = {
    metadata: async () => metadata,
    exchange: async (code) => { calls.exchange++; if (used.has(code)) throw new Error('code_used'); used.add(code);
      return { issuer, sub: 'owner-sub', accessToken: 'synthetic-access', ttl: 600 }; },
    revoke: async () => { calls.revoke++; },
    ...overrides,
    userinfo: async (session) => { calls.userinfo++; return overrides.userinfo ? overrides.userinfo(session) : user; },
  };
  const files = new Map([
    ['index.html', { access: 'public', bytes: Buffer.from('<a href="/view/lab-01/">Public lab</a><a href="/auth/login">Войти</a>'), contentType: 'text/html' }],
    ['admin/index.html', { access: 'admin', bytes: Buffer.from('<a href="/view/lab-01/">Public lab</a><a href="/view/lab-02/">Private lab</a><form action="/auth/logout"></form>'), contentType: 'text/html' }],
  ]);
  for (const [lab, access] of [['lab-01', 'public'], ['lab-02', 'admin']]) {
    for (const [name, contentType] of [['index.html', 'text/html'], ['style.css', 'text/css'],
      ['report/report.pdf', 'application/pdf'], ['img/example.png', 'image/png']]) {
      files.set(`${lab}/${name}`, { access, bytes: Buffer.from(`${access}:${lab}/${name}`), contentType });
    }
    files.set(`view/${lab}/index.html`, { access, bytes: Buffer.from(`${access} viewer`), contentType: 'text/html' });
  }
  files.set('media/private.webp', { access: 'admin', bytes: Buffer.from('private-image'), contentType: 'image/webp' });
  const quotePolicy = options.quoteAccess === undefined ? 'public' : options.quoteAccess;
  const cloud = {
    access: async (path) => files.get(path)?.access ?? null,
    quoteAccess: async () => quotePolicy,
    object: async (path) => { calls.object++; objectPaths.push(path); return files.get(path) || null; },
    quote: async () => { calls.quote++; return { text: 'test' }; },
  };
  const app = createApp({ config: c, oidc, cloud, audit: (event) => events.push(event) });
  const sessionCookie = pair(seal(c, SESSION_COOKIE, { issuer, sub: 'owner-sub', accessToken: 'synthetic-access' }, 600));
  return { c, app, calls, events, sessionCookie, objectPaths, files };
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

test('login page and styles remain public while unrecognised auth paths return not found', async () => {
  const { app, calls } = appFixture();
  const page = await request(app, '/lab-02/');
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
  for (const path of ['/auth/login.css/extra', '/auth/login.css.map']) {
    assert.equal((await request(app, path)).status, 404);
  }
  assert.equal(calls.object, 0);
  assert.equal(calls.quote, 0);
  assert.equal(calls.userinfo, 0);
});

test('public catalogue, lab HTML, viewer, styles, images and PDF work without identity requests', async () => {
  const { app, calls, objectPaths } = appFixture();
  const paths = ['/', '/index.html', '/lab-01/', '/view/lab-01/', '/lab-01/style.css',
    '/lab-01/img/example.png', '/lab-01/report/report.pdf'];
  for (const path of paths) {
    const response = await request(app, path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers['cache-control'], /no-store/);
    assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline/);
  }
  const catalogue = await request(app, '/');
  assert.match(catalogue.text, /Public lab/);
  assert.match(catalogue.text, /href="\/auth\/login"/);
  assert.doesNotMatch(catalogue.text, /Private lab|lab-02|auth\/logout/);
  const pdf = await request(app, '/lab-01/report/report.pdf');
  const head = await request(app, '/lab-01/report/report.pdf', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.bytes, undefined);
  assert.equal(head.headers['content-length'], pdf.bytes.length);
  assert.equal(calls.userinfo, 0);
  assert.equal(calls.object, paths.length + 3);
  assert.ok(objectPaths.every((path) => path === 'index.html' || path.includes('lab-01')));
});

test('direct private files and admin catalogue reject guests and spoofed identities before object reads', async () => {
  const { app, calls, sessionCookie } = appFixture();
  const paths = ['/admin/', '/admin/index.html', '/lab-02/', '/view/lab-02/',
    '/lab-02/style.css', '/lab-02/img/example.png', '/lab-02/report/report.pdf', '/media/private.webp',
    '/lab-02/%69ndex.html', '/lab-02/report/report.pdf?access=public'];
  for (const path of paths) {
    for (const method of ['GET', 'HEAD']) assert.equal((await request(app, path, { method })).status, 401, `${method} ${path}`);
  }
  const spoof = Buffer.from(JSON.stringify({ cookie: sessionCookie, groups: ['admin'] })).toString('base64');
  assert.equal((await request(app, '/lab-02/', { headers: {
    'x-yc-apigateway-operation-context': spoof, 'x-user-role': 'admin', authorization: 'Bearer synthetic-access',
  } })).status, 401);
  assert.equal((await request(app, '/lab-02/', { headers: { cookie: `${sessionCookie}; ${sessionCookie}` } })).status, 401);
  assert.equal(calls.object, 0);
  assert.equal(calls.userinfo, 0);
});

test('admin catalogue and private files require a fresh UserInfo check for every request', async () => {
  const { app, calls, sessionCookie, objectPaths } = appFixture();
  const headers = { cookie: sessionCookie };
  for (const path of ['/', '/index.html', '/admin/']) {
    const response = await request(app, path, { headers });
    assert.equal(response.status, 200);
    assert.match(response.text, /Public lab/);
    assert.match(response.text, /Private lab/);
    assert.match(response.text, /auth\/logout/);
    assert.doesNotMatch(response.text, /href="\/auth\/login"/);
  }
  assert.deepEqual(objectPaths, ['admin/index.html', 'admin/index.html', 'admin/index.html']);
  for (const path of ['/lab-02/', '/view/lab-02/', '/lab-02/style.css', '/lab-02/img/example.png',
    '/lab-02/report/report.pdf', '/media/private.webp']) {
    assert.equal((await request(app, path, { headers })).status, 200, path);
  }
  const head = await request(app, '/lab-02/report/report.pdf', { method: 'HEAD', headers });
  assert.equal(head.status, 200);
  assert.equal(head.bytes, undefined);
  assert.equal(calls.userinfo, 10);
  assert.equal(calls.object, 10);
  assert.equal((await request(app, '/lab-01/', { headers })).status, 200);
  assert.equal(calls.userinfo, 10);
});

test('public and private lab HTML can be framed only by their own host', async () => {
  const { app, calls, sessionCookie } = appFixture();
  for (const [path, headers] of [['/lab-01/', {}], ['/lab-02/', { cookie: sessionCookie }]]) {
    const lab = await request(app, path, { headers });
    assert.equal(lab.status, 200);
    assert.equal(lab.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(lab.headers['content-security-policy'], /frame-ancestors 'self'/);
    assert.doesNotMatch(lab.headers['content-security-policy'], /unsafe-inline/);
  }
  for (const path of ['/view/lab-01/', '/lab-01/report/report.pdf', '/']) {
    const other = await request(app, path);
    assert.equal(other.status, 200);
    assert.equal(other.headers['x-frame-options'], 'DENY');
    assert.match(other.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  const denied = await request(app, '/lab-02/');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers['x-frame-options'], 'DENY');
  assert.equal(calls.userinfo, 1);
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

test('revoked token and ID outage deny admin data while public files and catalogue stay available', async () => {
  const { app, calls, sessionCookie, objectPaths } = appFixture(
    { userinfo: async () => { throw new Error('revoked_or_unavailable'); } }, { quoteAccess: 'admin' });
  for (const path of ['/admin/', '/lab-02/report/report.pdf', '/api/v1/quote']) {
    const result = await request(app, path, { headers: { cookie: sessionCookie } });
    assert.equal(result.status, 401);
    assert.match(result.headers['set-cookie'][0], /Max-Age=0$/);
  }
  assert.equal(calls.object, 0);
  assert.equal(calls.quote, 0);
  assert.equal(calls.userinfo, 3);
  for (const path of ['/', '/index.html']) {
    const result = await request(app, path, { headers: { cookie: sessionCookie } });
    assert.equal(result.status, 200);
    assert.match(result.text, /Public lab/);
    assert.doesNotMatch(result.text, /Private lab|lab-02/);
    assert.match(result.headers['set-cookie'][0], /Max-Age=0$/);
  }
  assert.deepEqual(objectPaths, ['index.html', 'index.html']);
  const checks = calls.userinfo;
  assert.equal((await request(app, '/lab-01/report/report.pdf', { headers: { cookie: sessionCookie } })).status, 200);
  assert.equal(calls.userinfo, checks);
});

test('invalid, expired, duplicate and uninvited sessions fall back to the public catalogue', async () => {
  const { app, c, calls, sessionCookie, objectPaths } = appFixture();
  const session = { issuer, sub: 'owner-sub', accessToken: 'synthetic-access' };
  const invalidCookies = [
    `${SESSION_COOKIE}=invalid`,
    pair(seal(c, SESSION_COOKIE, session, 60, 1_000_000)),
    `${sessionCookie}; ${sessionCookie}`,
    pair(seal(c, SESSION_COOKIE, { ...session, sub: 'stranger' }, 600)),
    pair(seal(c, SESSION_COOKIE, { ...session, issuer: 'https://other.invalid' }, 600)),
  ];
  for (const cookie of invalidCookies) {
    const result = await request(app, '/', { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.match(result.text, /Public lab/);
    assert.doesNotMatch(result.text, /Private lab|lab-02/);
    assert.ok(result.headers['set-cookie'].some((value) => value.startsWith(`${SESSION_COOKIE}=`) && value.includes('Max-Age=0')));
    assert.equal((await request(app, '/lab-02/', { headers: { cookie } })).status, 401);
  }
  assert.equal(calls.userinfo, 0);
  assert.deepEqual(objectPaths, Array(invalidCookies.length).fill('index.html'));
});

test('quote API follows public, admin and disabled policy and accepts only GET', async () => {
  const publicQuote = appFixture();
  assert.equal((await request(publicQuote.app, '/api/v1/quote')).status, 200);
  assert.equal(publicQuote.calls.quote, 1);
  assert.equal(publicQuote.calls.userinfo, 0);
  const privateQuote = appFixture({}, { quoteAccess: 'admin' });
  assert.equal((await request(privateQuote.app, '/api/v1/quote')).status, 401);
  assert.equal(privateQuote.calls.quote, 0);
  assert.equal((await request(privateQuote.app, '/api/v1/quote', { headers: { cookie: privateQuote.sessionCookie } })).status, 200);
  assert.equal(privateQuote.calls.userinfo, 1);
  assert.equal(privateQuote.calls.quote, 1);
  const disabled = appFixture({}, { quoteAccess: null });
  for (const headers of [{}, { cookie: disabled.sessionCookie }]) {
    assert.equal((await request(disabled.app, '/api/v1/quote', { headers })).status, 404);
  }
  assert.equal(disabled.calls.quote, 0);
  assert.equal(disabled.calls.userinfo, 0);
  for (const { app, calls } of [publicQuote, privateQuote, disabled]) {
    const reads = calls.quote;
    const checks = calls.userinfo;
    for (const method of ['HEAD', 'POST']) {
      const result = await request(app, '/api/v1/quote', { method });
      assert.equal(result.status, 405);
      if (method === 'HEAD') {
        assert.equal(result.headers.allow, 'GET');
        assert.equal(result.bytes, undefined);
      }
    }
    assert.equal(calls.quote, reads);
    assert.equal(calls.userinfo, checks);
  }
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

test('missing configuration fails closed while an empty allowlist keeps the public site open', async () => {
  const unknown = createApp({ config: null });
  assert.equal((await request(unknown, '/')).status, 503);
  assert.equal((await request(unknown, '/healthz')).status, 503);
  const { app, calls, sessionCookie, objectPaths } = appFixture({}, { config: { ...config(), allowlist: [] } });
  for (const path of ['/', '/lab-01/', '/lab-01/report/report.pdf', '/api/v1/quote', '/auth/login.css']) {
    assert.equal((await request(app, path)).status, 200, path);
  }
  for (const path of ['/auth/login', '/auth/callback?code=x&state=y']) {
    assert.equal((await request(app, path)).status, 503, path);
  }
  assert.equal((await request(app, '/lab-02/', { headers: { cookie: sessionCookie } })).status, 401);
  const root = await request(app, '/', { headers: { cookie: sessionCookie } });
  assert.equal(root.status, 200);
  assert.doesNotMatch(root.text, /Private lab|lab-02/);
  assert.equal(calls.userinfo, 0);
  assert.equal(calls.exchange, 0);
  assert.ok(!objectPaths.includes('admin/index.html'));
});

test('unknown and malformed object paths do not fall through to a public object', async () => {
  const { app, calls, sessionCookie } = appFixture();
  for (const path of ['/lab-99/', '/lab-03/report/report.pdf', '/admin/missing.html', '/manifest.json',
    '/api/unknown', '/auth/unknown', '/../private', '/lab-02/%2e%2e/report.pdf', '/%ZZ', '//evil.invalid/']) {
    for (const headers of [{}, { cookie: sessionCookie }]) {
      assert.equal((await request(app, path, { headers })).status, 404, path);
    }
  }
  assert.equal(calls.object, 0);
  assert.equal(calls.userinfo, 0);
});

test('object paths reject traversal, encoded delimiters, absolute URLs and malformed escapes', () => {
  for (const path of ['/../private', '/lab-02/%2e%2e/report.pdf', '//evil.invalid/', '/%252e%252e/x',
    '/lab-02\\secret', '/%00', '/%ZZ', 'https://evil.invalid/a']) assert.equal(requestPath(path), null, path);
  assert.equal(requestPath('/'), 'index.html');
  assert.equal(requestPath('/lab-02/'), 'lab-02/index.html');
});

test('private object reader authenticates with metadata IAM and checks manifest allowlist/hash/size', async () => {
  const bytes = Buffer.from('<h1>private</h1>');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, releaseId, quoteAccess: 'admin', files: [
    { path: 'index.html', access: 'public', sha256: sha(bytes), size: bytes.length, contentType: 'text/html; charset=utf-8' },
    { path: 'admin/index.html', access: 'admin', sha256: sha(bytes), size: bytes.length, contentType: 'text/html; charset=utf-8' },
  ] }));
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
  assert.equal(await cloud.access('index.html'), 'public');
  assert.equal(await cloud.access('admin/index.html'), 'admin');
  assert.equal(await cloud.access('secret.env'), null);
  assert.equal(await cloud.quoteAccess(), 'admin');
  assert.equal(objectReads, 0);
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

test('manifest requires explicit access for each file and preserves catalogue boundaries', async () => {
  const bytes = Buffer.from('<h1>Catalogue</h1>');
  const entry = (path, access) => ({ path, access, sha256: sha(bytes), size: bytes.length, contentType: 'text/html' });
  const data = { schemaVersion: 2, releaseId, quoteAccess: 'public', files: [
    entry('index.html', 'public'), entry('admin/index.html', 'admin'), entry('lab-02/index.html', 'admin'),
  ] };
  const create = (value) => {
    const manifest = Buffer.from(JSON.stringify(value));
    return createCloud({ ...config(), manifestSha256: sha(manifest) }, async (url) => {
      if (url.startsWith('http://169.254.169.254/')) return json({ access_token: 'synthetic-iam', expires_in: 3600 });
      assert.ok(url.endsWith('/manifest.json'), 'policy lookup must not fetch any object body');
      return new Response(manifest);
    });
  };
  const valid = create(data);
  assert.ok(await valid.loadManifest() instanceof Map);
  assert.equal(await valid.access('lab-02/index.html'), 'admin');
  assert.equal(await valid.access('lab-03/index.html'), null);
  assert.equal(await valid.quoteAccess(), 'public');
  assert.equal(await create({ ...data, quoteAccess: null }).quoteAccess(), null);
  const invalid = [
    (value) => { value.schemaVersion = 1; },
    (value) => { delete value.quoteAccess; },
    (value) => { value.quoteAccess = 'members'; },
    (value) => { value.quoteAccess = false; },
    (value) => { delete value.files[2].access; },
    (value) => { value.files[2].access = 'members'; },
    (value) => { value.files[2].access = null; },
    (value) => { value.files[0].access = 'admin'; },
    (value) => { value.files[1].access = 'public'; },
    (value) => { value.files = value.files.filter((item) => item.path !== 'index.html'); },
    (value) => { value.files = value.files.filter((item) => item.path !== 'admin/index.html'); },
    (value) => { value.files.push({ ...value.files[0] }); },
  ];
  for (const change of invalid) {
    const value = structuredClone(data);
    change(value);
    const cloud = create(value);
    await assert.rejects(cloud.access('lab-02/index.html'), /manifest_(schema|entry|index)/);
    await assert.rejects(cloud.quoteAccess(), /manifest_(schema|entry|index)/);
  }
});

test('binary object budget admits the lossless image and rejects larger manifests/streams', async () => {
  assert.equal(MAX_FILE_BYTES, 2_200_000);
  const image = Buffer.alloc(2_025_528, 7);
  let declaredSize = image.length;
  let bytes = image;
  const create = () => {
    const empty = Buffer.alloc(0);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, releaseId, quoteAccess: null, files: [
      { path: 'index.html', access: 'public', sha256: sha(empty), size: 0, contentType: 'text/html' },
      { path: 'admin/index.html', access: 'admin', sha256: sha(empty), size: 0, contentType: 'text/html' },
      { path: 'media/reading-night.webp', access: 'public', sha256: sha(image), size: declaredSize, contentType: 'image/webp' },
    ] }));
    return createCloud({ ...config(), manifestSha256: sha(manifest) }, async (url) => {
      if (url.startsWith('http://169.254.169.254/')) return json({ access_token: 'synthetic-iam', expires_in: 3600 });
      return new Response(url.endsWith('/manifest.json') ? manifest : bytes);
    });
  };
  assert.equal((await create().object('media/reading-night.webp')).bytes.length, image.length);
  bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
  await assert.rejects(create().object('media/reading-night.webp'), /response_too_large/);
  declaredSize = MAX_FILE_BYTES + 1;
  await assert.rejects(create().loadManifest(), /manifest_entry/);
});
