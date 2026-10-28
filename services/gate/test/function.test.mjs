import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptRequest, createFunctionHandler, handler } from '../src/function.mjs';
import { createApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';
import { MAX_FILE_BYTES } from '../src/cloud.mjs';
import { SESSION_COOKIE, TRANSACTION_COOKIE, seal, open } from '../src/cookies.mjs';

const issuer = 'https://id.example.invalid';
const origin = 'https://labs.example.invalid';
const event = (path, values = {}) => ({ version: '1.0', path, httpMethod: 'GET',
  headers: {}, multiValueHeaders: {}, queryStringParameters: null, multiValueQueryStringParameters: null, ...values });
const config = () => readConfig({ PUBLIC_ORIGIN: origin, OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'etu-web',
  OIDC_CLIENT_SECRET: 'synthetic-secret', GATE_COOKIE_KEY: randomBytes(32).toString('base64url'),
  OIDC_ALLOWED_SUBJECTS: JSON.stringify([{ issuer, sub: 'owner' }]), STATIC_BUCKET: 'private-test',
  RELEASE_ID: 'a'.repeat(40), RELEASE_MANIFEST_SHA256: 'b'.repeat(64) });
const pair = (cookie) => cookie.split(';')[0];

function fixture(bytes = Buffer.from('private'), contentType = 'text/html') {
  const c = config();
  const calls = { exchange: 0, userinfo: 0, object: 0, revoke: 0 };
  const objectPaths = [];
  const oidc = {
    metadata: async () => ({ authorization_endpoint: `${issuer}/oauth/authorize` }),
    exchange: async () => { calls.exchange++; return { issuer, sub: 'owner', accessToken: 'test-token', ttl: 300 }; },
    userinfo: async () => { calls.userinfo++; },
    revoke: async () => { calls.revoke++; },
  };
  const policies = new Map([
    ['index.html', 'public'], ['admin/index.html', 'admin'],
    ['lab-01/index.html', 'public'], ['lab-01/report/report.pdf', 'public'],
    ['lab-07/assets/file', 'public'], ['lab-02/report/report.pdf', 'admin'],
  ]);
  const run = createFunctionHandler(createApp({ config: c, oidc, cloud: {
    access: async (path) => policies.get(path) ?? null,
    quoteAccess: async () => 'public',
    object: async (path) => { calls.object++; objectPaths.push(path); return { bytes, contentType }; },
  } }));
  const cookie = pair(seal(c, SESSION_COOKIE, { issuer, sub: 'owner', accessToken: 'test-token' }, 300));
  return { run, c, cookie, calls, objectPaths };
}

test('function adapter uses v1 actual path and preserves multi-value query/header data', () => {
  const req = adaptRequest(event('/auth/callback', {
    resource: '/{proxy+}', headers: { Cookie: 'b=2', Origin: origin },
    multiValueHeaders: { cookie: ['a=1', 'b=2'], ORIGIN: [origin] },
    queryStringParameters: { state: 'second', code: 'a+b &' },
    multiValueQueryStringParameters: { state: ['first', 'second'] },
  }));
  assert.equal(req.headers.cookie, 'a=1; b=2');
  assert.equal(req.headers.origin, origin);
  assert.equal(req.url.split('?')[0], '/auth/callback');
  const query = new URL(req.url, origin).searchParams;
  assert.deepEqual(query.getAll('state'), ['first', 'second']);
  assert.equal(query.get('code'), 'a+b &');
});

test('function adapter rejects wrong payload versions, malformed paths and ambiguous origin', async () => {
  for (const invalid of [event('/', { version: '2.0' }), event('/', { version: undefined }),
    event('https://evil.invalid/'), event('//evil.invalid/'), event('/?state=x'), event('/bad\\path'),
    event('/\n'), event('/', { httpMethod: 'get' }), event('/', { headers: { Cookie: 'a=1\r\nx:y' } }),
    event('/', { headers: { Origin: origin, origin } }), event('/', { multiValueHeaders: { Origin: [origin, origin] } }),
    event('/', { multiValueHeaders: { Cookie: ['x'.repeat(8193)] } }),
    event('/', { multiValueQueryStringParameters: { code: ['x'.repeat(4097)] } })]) {
    assert.equal((await handler(invalid)).statusCode, 400);
  }
});

test('function adapter callback returns two separate Set-Cookie headers and rejects repeated state', async () => {
  const { run, c, calls } = fixture();
  const login = await run(event('/auth/login', { queryStringParameters: { returnTo: '/lab-02/index.html' } }));
  assert.equal(login.statusCode, 303);
  const txCookie = pair(login.multiValueHeaders['set-cookie'][0]);
  const tx = open(c, TRANSACTION_COOKIE, txCookie);
  const callback = event('/auth/callback', { headers: { Cookie: txCookie },
    queryStringParameters: { code: 'one-use', state: tx.state } });
  const duplicate = await run({ ...callback, multiValueQueryStringParameters: { state: [tx.state, tx.state] } });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(calls.exchange, 0);
  assert.equal(duplicate.multiValueHeaders['set-cookie'].length, 2);
  const result = await run(callback);
  assert.equal(result.statusCode, 303);
  assert.equal(result.headers.location, '/lab-02/index.html');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.multiValueHeaders['set-cookie'].length, 2);
  assert.match(result.multiValueHeaders['set-cookie'][0], /Max-Age=0$/);
  assert.ok(open(c, SESSION_COOKIE, pair(result.multiValueHeaders['set-cookie'][1])));
});

test('function cookies and Origin use real event headers, never a client context header', async () => {
  const { run, cookie, calls, objectPaths } = fixture();
  const spoof = Buffer.from(JSON.stringify({ gateTransport: 'v1', cookie, origin })).toString('base64');
  assert.equal((await run(event('/admin/', { headers: { 'X-Yc-ApiGateway-Operation-Context': spoof } }))).statusCode, 401);
  assert.equal((await run(event('/admin/', { multiValueHeaders: { Cookie: [cookie, cookie] } }))).statusCode, 401);
  assert.equal(calls.object, 0);
  assert.equal(calls.userinfo, 0);
  assert.equal((await run(event('/', { headers: { 'X-Yc-ApiGateway-Operation-Context': spoof } }))).statusCode, 200);
  const publicFallback = await run(event('/', { multiValueHeaders: { Cookie: [cookie, cookie] } }));
  assert.equal(publicFallback.statusCode, 200);
  assert.match(publicFallback.multiValueHeaders['set-cookie'][0], /Max-Age=0$/);
  assert.deepEqual(objectPaths, ['index.html', 'index.html']);
  assert.equal(calls.userinfo, 0);
  const denied = await run(event('/auth/logout', { httpMethod: 'POST', headers: { Cookie: cookie,
    Origin: 'https://evil.invalid', 'X-Yc-ApiGateway-Operation-Context': spoof } }));
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.revoke, 0);
  const logout = await run(event('/auth/logout', { httpMethod: 'POST', multiValueHeaders: { Cookie: [cookie], Origin: [origin] } }));
  assert.equal(logout.statusCode, 303);
  assert.equal(logout.multiValueHeaders['set-cookie'].length, 2);
  assert.equal(calls.revoke, 1);
});

test('function adapter transports exact PDF, WebP and UTF-8 bytes within cloud limits', async () => {
  for (const [contentType, bytes] of [
    ['application/pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 128, 255, 13, 10])])],
    ['image/webp', randomBytes(MAX_FILE_BYTES)],
    ['text/html; charset=utf-8', Buffer.from('<h1>Лабораторные работы</h1>')],
  ]) {
    const { run, calls } = fixture(bytes, contentType);
    const result = await run(event('/lab-07/assets/file'));
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['content-type'], contentType);
    assert.equal(result.headers['content-length'], String(bytes.length));
    assert.equal(result.isBase64Encoded, true);
    assert.deepEqual(Buffer.from(result.body, 'base64'), bytes);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 3_400_000);
    assert.ok(bytes.length + Buffer.byteLength(JSON.stringify(result.headers)) < 2_500_000);
    assert.equal(calls.userinfo, 0);
  }
});

test('function adapter HEAD keeps object headers without a body; quote remains GET-only', async () => {
  const bytes = Buffer.from('PDF body');
  const { run, cookie, calls } = fixture(bytes, 'application/pdf');
  const result = await run(event('/lab-02/report/report.pdf', { httpMethod: 'HEAD', headers: { Cookie: cookie } }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['content-length'], String(bytes.length));
  assert.equal(result.body, '');
  assert.equal(result.isBase64Encoded, false);
  assert.equal(calls.userinfo, 1);
  assert.equal(calls.object, 1);
  const publicPdf = await run(event('/lab-01/report/report.pdf', { httpMethod: 'HEAD' }));
  assert.equal(publicPdf.statusCode, 200);
  assert.equal(publicPdf.headers['content-length'], String(bytes.length));
  assert.equal(publicPdf.body, '');
  assert.equal(publicPdf.isBase64Encoded, false);
  assert.equal(calls.userinfo, 1);
  assert.equal(calls.object, 2);
  const quote = await run(event('/api/v1/quote', { httpMethod: 'HEAD', headers: { Cookie: cookie } }));
  assert.equal(quote.statusCode, 405);
  assert.equal(quote.headers.allow, 'GET');
  assert.equal(quote.body, '');
});

test('function adapter fails closed on oversized responses and missing configuration', async () => {
  const { run, cookie } = fixture(Buffer.alloc(MAX_FILE_BYTES + 1));
  assert.equal((await run(event('/', { headers: { Cookie: cookie } }))).statusCode, 503);
  const unconfigured = createFunctionHandler(createApp({ config: null }));
  assert.equal((await unconfigured(event('/'))).statusCode, 503);
  assert.equal((await unconfigured(event('/healthz'))).statusCode, 503);
});

test('function ZIP is reproducible and its isolated CommonJS entrypoint resolves pinned jose', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-package-'));
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    const first = join(dir, 'first.zip'), second = join(dir, 'second.zip');
    execFileSync('python3', [join(root, 'package.py'), '--output', first]);
    execFileSync('python3', [join(root, 'package.py'), '--output', second]);
    const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    assert.equal(sha(first), sha(second));
    const extracted = join(dir, 'unpacked');
    execFileSync('python3', ['-m', 'zipfile', '-e', first, extracted]);
    const output = execFileSync(process.execPath, ['-e',
      'require("./index.js").handler({version:"1.0",path:"/",httpMethod:"GET"}).then(r=>{if(r.statusCode!==503)process.exit(2);process.stdout.write("deny")})'],
    { cwd: extracted, env: {}, encoding: 'utf8' });
    assert.equal(output, 'deny');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
