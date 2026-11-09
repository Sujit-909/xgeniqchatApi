import { createApp } from '../src/server.js';

export async function startApp(overrides = {}, deps = {}) {
  const app = createApp({ jwtSecret: 'test-secret', ringTimeoutMs: 400, disconnectGraceMs: 100, rateLimit: { windowMs: 60_000, max: 10_000, authMax: 10_000 }, ...overrides }, deps);
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, path, { token, body, headers } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const login = async (name) => {
    const r = await api('POST', '/v1/auth/login', { body: { email: `${name}@company.com`, password: 'Password@123' } });
    if (r.status !== 200) throw new Error(`login ${name} failed: ${r.status}`);
    return { ...r.body, id: r.body.user.appUserId };
  };
  const sockets = [];
  const connect = async (session) => {
    const t = await api('POST', '/v1/auth/ws-ticket', { token: session.accessToken });
    const c = await openSocket(`ws://127.0.0.1:${port}/ws`, { ticket: t.body.ticket });
    sockets.push(c);
    return c;
  };
  const reset = async () => { for (const c of sockets.splice(0)) await c.close().catch(() => {}); app.sap.backend.failing = false; app.sap.breaker.failures = 0; };
  return { app, port, base, api, login, connect, reset, stop: async () => { await reset(); await app.close(); } };
}

export function openSocket(url, authMsg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue = []; const waiters = []; let closed = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const i = waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); } else queue.push(msg);
    };
    ws.onclose = (ev) => { closed = ev.code; for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error(`socket closed (${ev.code}) while waiting`)); } };
    ws.onerror = () => {};
    const client = {
      ws,
      authMsg: null,
      ack: (ref, ms) => client.waitFor((m) => m.type === 'ack' && m.ref === ref, ms),
      send: (m) => ws.send(JSON.stringify(m)),
      get closedCode() { return closed; },
      waitFor: (pred, ms = 2000) => {
        const p = typeof pred === 'string' ? (m) => m.type === pred : pred;
        const i = queue.findIndex(p);
        if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting for ${typeof pred === 'string' ? pred : 'message'}; queue=${JSON.stringify(queue.map((q) => q.type))}`)), ms);
          waiters.push({ pred: p, resolve: res, reject: rej, timer });
        });
      },
      expectNone: async (type, ms = 150) => { await new Promise((r) => setTimeout(r, ms)); return !queue.some((m) => m.type === type); },
      close: () => new Promise((r) => { if (closed !== null) return r(); ws.addEventListener('close', () => r()); ws.close(); }),
    };
    ws.onopen = async () => {
      if (!authMsg) return resolve(client);
      client.send({ type: 'auth', ...authMsg });
      try { client.authMsg = await client.waitFor((m) => m.type === 'auth:ok' || m.type === 'auth:error'); } catch (e) { /* closed by server */ }
      resolve(client);
    };
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}
