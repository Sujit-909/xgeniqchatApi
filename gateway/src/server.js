import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { HttpError, Router, RateLimiter, readJson, sendJson } from './lib/http.js';
import { attachWebSocket } from './lib/ws.js';
import { SapClient, publicUser } from './services/sap.js';
import { AuthService } from './services/auth.js';
import { ChatService } from './services/chat.js';
import { CallService } from './services/calls.js';
import { VideoService } from './services/video.js';
import { AiService } from './services/ai.js';
import { NotificationService } from './services/notifications.js';
import { RealtimeHub } from './realtime.js';

export function createApp(overrides = {}, deps = {}) {
  const config = loadConfig(overrides);
  const sap = deps.sap || new SapClient(config);
  const auth = new AuthService(config, sap);
  const chat = new ChatService();
  const video = new VideoService(config);
  const notifications = new NotificationService();
  const ai = new AiService(config, sap, deps.fetch);
  let calls;
  const hub = new RealtimeHub({ auth, chat, sap, getCalls: () => calls, config });
  calls = new CallService({ config, sap, auth, video, notifications, emit: (id, m) => hub.emit(id, m), isOnline: (id) => hub.isOnline(id) });

  const limiter = new RateLimiter(config.rateLimit);
  const authLimiter = new RateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.authMax });
  const router = new Router();
  const authed = (fn, perm) => async (ctx) => {
    const h = ctx.req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Missing bearer token');
    ctx.user = await auth.authenticate(h.slice(7));
    if (perm) auth.requirePermission(ctx.user, perm);
    return fn(ctx);
  };

  router.get('/health', async () => ({ status: 200, body: { status: 'ok', uptime: process.uptime(), online: hub.onlineIds().length, videoProvider: video.provider, aiProvider: ai.provider } }));

  // --- Auth ---
  router.post('/v1/auth/login', async ({ body, ip }) => {
    const r = authLimiter.check(`login:${ip}`);
    if (!r.ok) throw new HttpError(429, 'Too many attempts. Try again later.');
    return { status: 200, body: await auth.login(body.email, body.password) };
  });
  router.post('/v1/auth/refresh', async ({ body, ip }) => {
    if (!authLimiter.check(`refresh:${ip}`).ok) throw new HttpError(429, 'Too many attempts');
    return { status: 200, body: await auth.refresh(body.refreshToken) };
  });
  router.post('/v1/auth/logout', async ({ body }) => { auth.logout(body.refreshToken); return { status: 204 }; });
  router.post('/v1/auth/ws-ticket', authed(async ({ user }) => ({ status: 200, body: auth.createWsTicket(user) })));
  router.get('/v1/me', authed(async ({ user }) => ({ status: 200, body: { user: publicUser(user) } })));

  // --- Directory ---
  router.get('/v1/users', authed(async () => {
    const users = await sap.listUsers();
    return { status: 200, body: { users: users.filter((u) => u.status === 'active').map((u) => ({ ...publicUser(u), online: hub.isOnline(u.appUserId) })) } };
  }));

  // --- Chat ---
  router.get('/v1/chat/conversations', authed(async ({ user }) => ({ status: 200, body: { conversations: chat.listFor(user.appUserId) } }), 'chat:use'));
  router.post('/v1/chat/conversations', authed(async ({ user, body }) => {
    const valid = new Set((await sap.listUsers()).filter((u) => u.status === 'active').map((u) => u.appUserId));
    if (!Array.isArray(body.memberIds)) throw new HttpError(400, 'memberIds must be an array');
    const conversation = chat.createConversation(user.appUserId, body, valid);
    for (const id of conversation.memberIds) hub.emit(id, { type: 'chat:conversation', conversation });
    return { status: 201, body: { conversation } };
  }, 'chat:use'));
  router.get('/v1/chat/conversations/:id/messages', authed(async ({ user, params, query }) => ({ status: 200, body: { messages: chat.history(user.appUserId, params.id, { before: query.get('before'), limit: query.get('limit') }) } }), 'chat:use'));
  router.post('/v1/chat/conversations/:id/messages', authed(async ({ user, params, body }) => {
    const { message, conversation, duplicate } = chat.send(user.appUserId, params.id, body.text, body.clientId);
    if (!duplicate) for (const id of conversation.memberIds) hub.emit(id, { type: 'chat:message', message });
    return { status: duplicate ? 200 : 201, body: { message } };
  }, 'chat:use'));
  router.post('/v1/chat/conversations/:id/read', authed(async ({ user, params }) => { chat.markRead(user.appUserId, params.id); return { status: 204 }; }, 'chat:use'));

  // --- Calls (actions run over WebSocket; REST covers history, lookup and join credentials) ---
  router.get('/v1/calls', authed(async ({ user }) => ({ status: 200, body: { calls: calls.history(user) } })));
  router.get('/v1/calls/active', authed(async ({ user }) => ({ status: 200, body: { call: calls.activeFor(user.appUserId) } })));
  router.get('/v1/calls/:id', authed(async ({ user, params }) => ({ status: 200, body: { call: calls.get(user, params.id) } })));
  router.post('/v1/calls/:id/token', authed(async ({ user, params }) => ({ status: 200, body: calls.joinInfo(user, params.id) })));

  // --- AI ---
  router.post('/v1/ai/chat', authed(async ({ user, body }) => ({ status: 200, body: await ai.chat(user, body.messages) })));
  router.post('/v1/ai/summarize', authed(async ({ user, body }) => ({ status: 200, body: await ai.summarize(user, body) })));
  router.post('/v1/ai/drafts/:id/approve', authed(async ({ user, params, body }) => ({ status: 200, body: await ai.approve(user, params.id, body) })));

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const allowed = origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin));
    const cors = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
    const sec = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403, { ...cors, ...sec }); return res.end(); }
      const ip = req.socket.remoteAddress || 'unknown';
      const rl = limiter.check(ip);
      if (!rl.ok) throw Object.assign(new HttpError(429, 'Rate limit exceeded'), { retryAfter: rl.retryAfterSec });
      const m = router.match(req.method, url.pathname);
      if (!m.handler) throw new HttpError(m.pathMatched ? 405 : 404, m.pathMatched ? 'Method not allowed' : 'Not found');
      const body = req.method === 'POST' ? await readJson(req) : {};
      const out = await m.handler({ req, params: m.params, query: url.searchParams, body, ip });
      if (out.status === 204) { res.writeHead(204, { ...cors, ...sec }); return res.end(); }
      return sendJson(res, out.status, out.body, { ...cors, ...sec });
    } catch (e) {
      if (!(e instanceof HttpError) && /^SAP/.test(e?.message || '')) e = new HttpError(503, 'SAP is temporarily unavailable', 'SAP_UNAVAILABLE');
      const known = e instanceof HttpError;
      if (!known) console.error('request error', e);
      const headers = { ...cors, ...sec, ...(e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {}) };
      return sendJson(res, known ? e.status : 500, { error: known ? e.message : 'Internal server error', code: known ? e.code : 'INTERNAL' }, headers);
    }
  });

  const wss = attachWebSocket(server, { path: '/ws', allowedOrigins: config.corsOrigins, onConnection: (conn) => hub.handleConnection(conn) });

  return {
    config, server, sap, auth, chat, calls, hub, ai, video, notifications,
    listen: (port = config.port) => new Promise((resolve) => server.listen(port, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { wss.close(); hub.close(); calls.close(); sap.close(); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen().then((port) => {
    console.log(`Gateway listening on :${port} (video: ${app.video.provider}, ai: ${app.ai.provider})`);
    if (!app.config.isProd) console.log('Demo users: alice@company.com / bob@company.com / carol@company.com / dave@company.com  password: Password@123');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
}
