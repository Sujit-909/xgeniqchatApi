// Tests the Next.js server-side layer (login/logout routes, gateway proxy, middleware) against a real gateway,
// with a minimal stand-in for next/server (Next itself is not needed to exercise this logic).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createApp } from '../../gateway/src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bff-'));
const require = createRequire(import.meta.url);

const plugin = {
  name: 'stubs',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (a) => { const base = path.join(root, a.path.slice(2)); for (const ext of ['', '.js']) if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { path: base + ext }; });
    b.onResolve({ filter: /^next\/server$/ }, () => ({ path: 'next/server', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
      export class NextResponse extends Response {
        constructor(body, init) { super(body, init); this.jar = {}; this.cookies = { set: (n, v, o = {}) => { this.jar[n] = { value: v, ...o }; } }; }
        static json(data, init = {}) { return new NextResponse(JSON.stringify(data), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }); }
        static redirect(u) { const r = new NextResponse(null, { status: 307 }); r.redirectedTo = u.pathname; return r; }
        static next() { const r = new NextResponse(null, { status: 200 }); r.passed = true; return r; }
      }` }));
  },
};
async function load(entry) {
  const out = path.join(tmp, entry.replace(/[^\w]/g, '_') + '.cjs');
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs', outfile: out, plugins: [plugin], logLevel: 'silent' });
  return require(out);
}

let app; let base; let proxy; let login; let logout; let mw;
before(async () => {
  app = createApp({ jwtSecret: 'bff-test', rateLimit: { windowMs: 60_000, max: 10_000, authMax: 10_000 } });
  const port = await app.listen(0); base = `http://127.0.0.1:${port}`;
  process.env.GATEWAY_URL = base; // read by lib/server/session.js when the bundles load
  proxy = await load('app/api/gw/[...path]/route.js');
  login = await load('app/api/auth/login/route.js');
  logout = await load('app/api/auth/logout/route.js');
  mw = await load('middleware.js');
});
after(async () => { await app.close(); });

const mkReq = (method, url, { cookies = {}, headers = {}, body } = {}) => ({
  method, url, headers: new Headers({ host: 'localhost:3000', ...headers }),
  cookies: { get: (n) => (cookies[n] !== undefined ? { value: cookies[n] } : undefined) },
  text: async () => body ?? '', json: async () => JSON.parse(body || '{}'),
  nextUrl: { pathname: new URL(url).pathname, clone() { return { pathname: new URL(url).pathname }; } },
});
const gw = (p, extra, method = 'GET') => proxy[method](mkReq(method, `http://localhost:3000/api/gw/${p.join('/')}`, extra), { params: Promise.resolve({ path: p }) });
async function doLogin(email = 'alice@company.com', password = 'Password@123') {
  return login.POST(mkReq('POST', 'http://localhost:3000/api/auth/login', { body: JSON.stringify({ email, password }) }));
}

test('login route: sets HTTP-only cookies, returns the user but never the tokens', async () => {
  const res = await doLogin();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.name, 'Alice Manager'); assert.equal(body.accessToken, undefined); assert.equal(body.refreshToken, undefined);
  assert.equal(res.jar.hub_at.httpOnly, true); assert.equal(res.jar.hub_rt.httpOnly, true);
  assert.equal(res.jar.hub_at.sameSite, 'lax'); assert.ok(res.jar.hub_at.value.split('.').length === 3);
});

test('login route: wrong password -> 401 without cookies; missing fields -> 400; gateway down -> 502', async () => {
  const bad = await doLogin('alice@company.com', 'nope');
  assert.equal(bad.status, 401); assert.deepEqual(bad.jar, {});
  assert.equal((await login.POST(mkReq('POST', 'http://localhost:3000/api/auth/login', { body: '{}' }))).status, 400);
  const saved = process.env.GATEWAY_URL;
  const down = await load('app/api/auth/login/route.js'); // fresh bundle bound to an unreachable gateway
  process.env.GATEWAY_URL = saved;
  // the bundle above captured the live URL at load time; build one against a dead port explicitly
  process.env.GATEWAY_URL = 'http://127.0.0.1:1';
  const dead = await build({ entryPoints: [path.join(root, 'app/api/auth/login/route.js')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'dead.cjs'), plugins: [plugin], logLevel: 'silent' }).then(() => require(path.join(tmp, 'dead.cjs')));
  process.env.GATEWAY_URL = saved;
  const r = await dead.POST(mkReq('POST', 'http://localhost:3000/api/auth/login', { body: JSON.stringify({ email: 'a@b.c', password: 'x' }) }));
  assert.equal(r.status, 502); assert.match((await r.json()).error, /gateway/i); assert.ok(down.POST);
});

test('proxy: forwards the bearer token from the cookie and returns gateway JSON', async () => {
  const s = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'bob@company.com', password: 'Password@123' }) })).json());
  const res = await gw(['me'], { cookies: { hub_at: s.accessToken, hub_rt: s.refreshToken } });
  assert.equal(res.status, 200); assert.equal((await res.json()).user.appUserId, 'APP00002');
  assert.deepEqual(res.jar, {}, 'no cookie churn when the token is still valid');
  const users = await gw(['users'], { cookies: { hub_at: s.accessToken } });
  assert.equal((await users.json()).users.length, 4);
});

test('proxy: expired access token is refreshed transparently once and new cookies are issued', async () => {
  const s = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'carol@company.com', password: 'Password@123' }) })).json());
  const res = await gw(['me'], { cookies: { hub_at: 'expired.token.value', hub_rt: s.refreshToken } });
  assert.equal(res.status, 200); assert.equal((await res.json()).user.appUserId, 'APP00003');
  assert.ok(res.jar.hub_at.value && res.jar.hub_rt.value && res.jar.hub_rt.value !== s.refreshToken, 'rotated refresh token issued');
  const again = await gw(['me'], { cookies: { hub_at: 'expired.token.value', hub_rt: s.refreshToken } }); // reusing the old refresh token must fail
  assert.equal(again.status, 401); assert.equal(again.jar.hub_at.maxAge, 0, 'dead session cookies are cleared');
  const none = await gw(['me'], {});
  assert.equal(none.status, 401);
});

test('proxy: blocks credential endpoints, path tricks and cross-origin writes; allows the WS ticket', async () => {
  assert.equal((await gw(['auth', 'login'], { body: '{}' }, 'POST')).status, 404);
  assert.equal((await gw(['auth', 'refresh'], { body: '{"refreshToken":"x"}' }, 'POST')).status, 404);
  assert.equal((await gw(['auth', 'logout'], { body: '{}' }, 'POST')).status, 404);
  assert.equal((await gw(['..', 'health'], {})).status, 400);
  const s = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dave@company.com', password: 'Password@123' }) })).json());
  const evil = await gw(['auth', 'ws-ticket'], { cookies: { hub_at: s.accessToken }, headers: { origin: 'https://evil.example' } }, 'POST');
  assert.equal(evil.status, 403);
  const ok = await gw(['auth', 'ws-ticket'], { cookies: { hub_at: s.accessToken }, headers: { origin: 'http://localhost:3000' } }, 'POST');
  assert.equal(ok.status, 200); assert.ok((await ok.json()).ticket);
});

test('proxy: POST bodies, status codes (201/204/4xx) and query strings pass through', async () => {
  const a = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alice@company.com', password: 'Password@123' }) })).json());
  const c = { hub_at: a.accessToken };
  const created = await gw(['chat', 'conversations'], { cookies: c, body: JSON.stringify({ memberIds: ['APP00002'] }), headers: { origin: 'http://localhost:3000' } }, 'POST');
  assert.equal(created.status, 201); const conv = (await created.json()).conversation;
  const read = await gw(['chat', 'conversations', conv.id, 'read'], { cookies: c, headers: { origin: 'http://localhost:3000' } }, 'POST');
  assert.equal(read.status, 204);
  const miss = await gw(['chat', 'conversations', 'nope', 'messages'], { cookies: c });
  assert.equal(miss.status, 404);
  const q = await proxy.GET(mkReq('GET', `http://localhost:3000/api/gw/chat/conversations/${conv.id}/messages?limit=1`, { cookies: c }), { params: Promise.resolve({ path: ['chat', 'conversations', conv.id, 'messages'] }) });
  assert.equal(q.status, 200);
});

test('logout route revokes the refresh token at the gateway and clears cookies', async () => {
  const res0 = await doLogin('bob@company.com');
  const rt = res0.jar.hub_rt.value;
  const out = await logout.POST(mkReq('POST', 'http://localhost:3000/api/auth/logout', { cookies: { hub_rt: rt } }));
  assert.equal(out.status, 200); assert.equal(out.jar.hub_at.maxAge, 0); assert.equal(out.jar.hub_rt.maxAge, 0);
  const r = await fetch(`${base}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
  assert.equal(r.status, 401);
});

test('middleware: redirects anonymous page visits to /login, lets /login and signed-in users through', () => {
  const run = (p, cookies = {}) => mw.middleware(mkReq('GET', `http://localhost:3000${p}`, { cookies }));
  assert.equal(run('/chat').redirectedTo, '/login');
  assert.equal(run('/call').redirectedTo, '/login');
  assert.equal(run('/login').passed, true);
  assert.equal(run('/chat', { hub_at: 'x' }).passed, true);
  assert.equal(run('/chat', { hub_rt: 'x' }).passed, true, 'refresh cookie alone keeps the session alive');
});
