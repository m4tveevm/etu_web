import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { allowed } from './config.mjs';
import { seal, open, clearCookie, SESSION_COOKIE, TRANSACTION_COOKIE } from './cookies.mjs';
import { requestPath } from './cloud.mjs';

const LOGIN_PAGE = readFileSync(new URL('./login.html', import.meta.url));
const LOGIN_CSS = readFileSync(new URL('./login.css', import.meta.url));

const SECURITY_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp({ config, oidc, cloud, audit = () => {} }) {
  return async function handle(req, res) {
    let clearSession = false;
    const reply = (status, body = '', headers = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8',
        'content-length': bytes.length,
        ...(clearSession ? { 'set-cookie': [clearCookie(SESSION_COOKIE)] } : {}), ...headers });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    const redirect = (location, cookies = []) => reply(303, '', { location, 'set-cookie': cookies });
    let transactionCleared = false;
    try {
      if (!req.url || req.url.length > 4096) return reply(400, 'Некорректный запрос.');
      const url = new URL(req.url, config?.origin || 'https://unconfigured.invalid');
      if (url.pathname === '/healthz') return reply(config ? 200 : 503, config ? 'ok' : 'unavailable');
      if (!config) return reply(503, 'Сайт ещё не настроен.');
      if (!['GET', 'HEAD', 'POST'].includes(req.method)) return reply(405, 'Метод не поддерживается.');
      const cookies = req.headers.cookie;
      let admin;
      const isAdmin = async () => {
        if (admin !== undefined) return admin;
        const session = open(config, SESSION_COOKIE, cookies);
        if (!session || !allowed(config, session.issuer, session.sub)) {
          clearSession = true;
          return (admin = false);
        }
        // Recheck the account on every request that can reveal admin-only content.
        try {
          await oidc.userinfo(session);
          return (admin = true);
        } catch {
          audit('session_validation_failed');
          clearSession = true;
          return (admin = false);
        }
      };
      const requireLogin = () => reply(401, LOGIN_PAGE, {
        'content-type': 'text/html; charset=utf-8', 'set-cookie': [clearCookie(SESSION_COOKIE)],
      });

      if (url.pathname === '/auth/login.css') {
        if (!['GET', 'HEAD'].includes(req.method)) return reply(405, 'Метод не поддерживается.');
        return reply(200, LOGIN_CSS, { 'content-type': 'text/css; charset=utf-8' });
      }

      if (url.pathname === '/auth/login') {
        if (req.method !== 'GET') return reply(405, 'Метод не поддерживается.');
        if (!config.allowlist.length) return reply(503, 'Вход администратора ещё не настроен.');
        const metadata = await oidc.metadata();
        const state = random();
        const nonce = random();
        const verifier = random();
        const returnPath = requestPath(url.searchParams.get('returnTo') || '/');
        const returnTo = returnPath && !returnPath.startsWith('auth/') && !returnPath.startsWith('api/') ? `/${returnPath}` : '/';
        const cookie = seal(config, TRANSACTION_COOKIE, { state, nonce, verifier, returnTo }, 300);
        const target = new URL(metadata.authorization_endpoint);
        target.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.callback,
          response_type: 'code', response_mode: 'query', scope: 'openid', state, nonce,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return redirect(target.href, [cookie]);
      }

      if (url.pathname === '/auth/callback') {
        if (req.method !== 'GET') return reply(405, 'Метод не поддерживается.');
        if (!config.allowlist.length) return reply(503, 'Вход администратора ещё не настроен.');
        transactionCleared = true;
        const cleared = [clearCookie(TRANSACTION_COOKIE), clearCookie(SESSION_COOKIE)];
        const transaction = open(config, TRANSACTION_COOKIE, cookies);
        if (!transaction || !equal(transaction.state, url.searchParams.get('state'))
          || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1
          || url.searchParams.has('error') || [...url.searchParams.keys()].some((key) => !['state', 'code'].includes(key))) {
          audit('callback_rejected');
          return reply(400, 'Вход не завершён. Начните вход заново.', { 'set-cookie': cleared });
        }
        const code = url.searchParams.get('code');
        if (!code || code.length > 512) return reply(400, 'Некорректный код входа.', { 'set-cookie': cleared });
        const session = await oidc.exchange(code, transaction.verifier, transaction.nonce);
        if (!allowed(config, session.issuer, session.sub)) {
          await oidc.revoke(session.accessToken).catch(() => audit('revocation_failed'));
          audit('access_denied');
          return reply(403, 'Этот аккаунт не имеет доступа администратора.', { 'set-cookie': cleared });
        }
        try { await oidc.userinfo(session); } catch (error) {
          await oidc.revoke(session.accessToken).catch(() => audit('revocation_failed'));
          throw error;
        }
        let sessionCookie;
        try { sessionCookie = seal(config, SESSION_COOKIE, {
          issuer: session.issuer, sub: session.sub, accessToken: session.accessToken,
        }, session.ttl); } catch (error) {
          await oidc.revoke(session.accessToken).catch(() => audit('revocation_failed'));
          throw error;
        }
        audit('login_succeeded');
        return redirect(transaction.returnTo, [clearCookie(TRANSACTION_COOKIE), sessionCookie]);
      }

      if (url.pathname === '/auth/logout') {
        if (req.method !== 'POST') return reply(405, 'Используйте кнопку выхода.');
        if (req.headers.origin !== config.origin) return reply(403, 'Запрос отклонён.');
        const session = open(config, SESSION_COOKIE, cookies);
        if (session?.accessToken) await oidc.revoke(session.accessToken).catch(() => audit('revocation_failed'));
        audit('logout');
        return redirect('/', [clearCookie(SESSION_COOKIE), clearCookie(TRANSACTION_COOKIE)]);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'Метод не поддерживается.');
      if (url.pathname === '/api/v1/quote') {
        if (req.method !== 'GET') return reply(405, 'Метод не поддерживается.', { allow: 'GET' });
        const access = await cloud.quoteAccess();
        if (access === null) return reply(404, 'Страница не найдена.');
        if (!['public', 'admin'].includes(access)) throw new Error('invalid_access');
        if (access === 'admin' && !await isAdmin()) return requireLogin();
        return reply(200, JSON.stringify(await cloud.quote()), { 'content-type': 'application/json; charset=utf-8' });
      }
      let path = requestPath(req.url);
      if (!path || path.startsWith('auth/') || path.startsWith('api/')) return reply(404, 'Страница не найдена.');
      const hasSession = cookies?.split(';').some((cookie) => cookie.trim().startsWith(`${SESSION_COOKIE}=`));
      if (path === 'index.html' && hasSession && await isAdmin()) path = 'admin/index.html';
      const access = await cloud.access(path);
      if (access === null) return reply(404, 'Страница не найдена.');
      if (!['public', 'admin'].includes(access)) throw new Error('invalid_access');
      if (access === 'admin' && !await isAdmin()) return requireLogin();
      const object = await cloud.object(path);
      if (!object) return reply(404, 'Страница не найдена.');
      const frameHeaders = /^lab-\d{2}\/[^/]+\.html$/.test(path)
        && object.contentType.startsWith('text/html')
        ? { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy':
          SECURITY_HEADERS['content-security-policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'") }
        : {};
      return reply(200, object.bytes, { 'content-type': object.contentType, ...frameHeaders });
    } catch {
      audit('request_failed');
      return reply(503, 'Сервис временно недоступен.', transactionCleared
        ? { 'set-cookie': [clearCookie(TRANSACTION_COOKIE), clearCookie(SESSION_COOKIE)] } : {});
    }
  };
}
