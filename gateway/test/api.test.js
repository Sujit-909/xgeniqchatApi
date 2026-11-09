import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { signJwt } from '../src/lib/jwt.js';

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.stop(); });

test('health is public', async () => {
  const r = await t.api('GET', '/health');
  assert.equal(r.status, 200); assert.equal(r.body.status, 'ok');
});

test('login succeeds and never leaks password hash / SAP ids', async () => {
  const s = await t.login('alice');
  assert.ok(s.accessToken && s.refreshToken);
  assert.equal(s.user.passwordHash, undefined); assert.equal(s.user.sapUserId, undefined);
  assert.equal(s.user.role, 'manager');
});

test('login rejects wrong password, unknown user, missing fields, inactive user', async () => {
  assert.equal((await t.api('POST', '/v1/auth/login', { body: { email: 'alice@company.com', password: 'nope' } })).status, 401);
  assert.equal((await t.api('POST', '/v1/auth/login', { body: { email: 'ghost@company.com', password: 'Password@123' } })).status, 401);
  assert.equal((await t.api('POST', '/v1/auth/login', { body: {} })).status, 400);
  assert.equal((await t.api('POST', '/v1/auth/login', { body: { email: 'erin@company.com', password: 'Password@123' } })).status, 403);
});

test('invalid JSON returns 400, unknown route 404, wrong method 405', async () => {
  const res = await fetch(t.base + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal((await t.api('GET', '/nope')).status, 404);
  assert.equal((await t.api('GET', '/v1/auth/login')).status, 405);
});

test('protected routes need a valid token; alg:none and forged tokens are rejected', async () => {
  assert.equal((await t.api('GET', '/v1/me')).status, 401);
  assert.equal((await t.api('GET', '/v1/me', { token: 'garbage' })).status, 401);
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"APP00001","typ":"access"}').toString('base64url')}.`;
  assert.equal((await t.api('GET', '/v1/me', { token: none })).status, 401);
  const forged = signJwt({ sub: 'APP00001', typ: 'access' }, 'wrong-secret', { expiresInSec: 60 });
  assert.equal((await t.api('GET', '/v1/me', { token: forged })).status, 401);
  const expired = signJwt({ sub: 'APP00001', typ: 'access', exp: 1 }, 'test-secret');
  assert.equal((await t.api('GET', '/v1/me', { token: expired })).status, 401);
  const refreshAsAccess = signJwt({ sub: 'APP00001', typ: 'refresh' }, 'test-secret', { expiresInSec: 60 });
  assert.equal((await t.api('GET', '/v1/me', { token: refreshAsAccess })).status, 401);
});

test('refresh rotates: old refresh token cannot be reused; logout revokes', async () => {
  const s = await t.login('bob');
  const r1 = await t.api('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } });
  assert.equal(r1.status, 200);
  assert.equal((await t.api('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401);
  await t.api('POST', '/v1/auth/logout', { body: { refreshToken: r1.body.refreshToken } });
  assert.equal((await t.api('POST', '/v1/auth/refresh', { body: { refreshToken: r1.body.refreshToken } })).status, 401);
});

test('login is rate limited', async () => {
  const x = await startApp({ rateLimit: { windowMs: 60_000, max: 10_000, authMax: 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await x.api('POST', '/v1/auth/login', { body: { email: 'alice@company.com', password: 'bad' } })).status);
  await x.stop();
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('directory lists only active users with presence', async () => {
  const s = await t.login('alice');
  const r = await t.api('GET', '/v1/users', { token: s.accessToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.users.length, 4);
  assert.ok(!r.body.users.some((u) => u.email === 'erin@company.com'));
});

test('deactivating a user in SAP blocks their token once cache is invalidated', async () => {
  const s = await t.login('carol');
  assert.equal((await t.api('GET', '/v1/me', { token: s.accessToken })).status, 200);
  t.app.sap.backend.users.get(s.id).status = 'inactive';
  t.app.auth.revokeUser(s.id);
  assert.equal((await t.api('GET', '/v1/me', { token: s.accessToken })).status, 401);
  assert.equal((await t.api('POST', '/v1/auth/refresh', { body: { refreshToken: s.refreshToken } })).status, 401);
  t.app.sap.backend.users.get(s.id).status = 'active'; t.app.sap.invalidate(s.id);
});

test('chat REST: direct conversation is deduplicated, messages are idempotent, members only', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  const c1 = await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id] } });
  const c2 = await t.api('POST', '/v1/chat/conversations', { token: b.accessToken, body: { memberIds: [a.id] } });
  assert.equal(c1.status, 201); assert.equal(c1.body.conversation.id, c2.body.conversation.id);
  const id = c1.body.conversation.id;
  const m1 = await t.api('POST', `/v1/chat/conversations/${id}/messages`, { token: a.accessToken, body: { text: ' hello ', clientId: 'x1' } });
  const m2 = await t.api('POST', `/v1/chat/conversations/${id}/messages`, { token: a.accessToken, body: { text: ' hello ', clientId: 'x1' } });
  assert.equal(m1.status, 201); assert.equal(m2.status, 200); assert.equal(m1.body.message.id, m2.body.message.id);
  assert.equal(m1.body.message.text, 'hello');
  const list = await t.api('GET', '/v1/chat/conversations', { token: b.accessToken });
  assert.equal(list.body.conversations[0].unread, 1);
  await t.api('POST', `/v1/chat/conversations/${id}/read`, { token: b.accessToken });
  assert.equal((await t.api('GET', '/v1/chat/conversations', { token: b.accessToken })).body.conversations[0].unread, 0);
  assert.equal((await t.api('GET', `/v1/chat/conversations/${id}/messages`, { token: c.accessToken })).status, 404);
  assert.equal((await t.api('POST', `/v1/chat/conversations/${id}/messages`, { token: c.accessToken, body: { text: 'hi' } })).status, 404);
  assert.equal((await t.api('POST', `/v1/chat/conversations/${id}/messages`, { token: a.accessToken, body: { text: '   ' } })).status, 400);
  assert.equal((await t.api('POST', `/v1/chat/conversations/${id}/messages`, { token: a.accessToken, body: { text: 'x'.repeat(4001) } })).status, 400);
});

test('chat groups need a name and valid members', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  assert.equal((await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id, c.id] } })).status, 400);
  const g = await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id, c.id], name: 'Plant crew' } });
  assert.equal(g.status, 201); assert.equal(g.body.conversation.type, 'group');
  assert.equal((await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: ['APP99999'] } })).status, 404);
  assert.equal((await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [a.id] } })).status, 400);
});

test('video join info: mesh by default, LiveKit token when configured (identity = app user id)', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const inc = await wb.waitFor('call:incoming');
  assert.equal((await t.api('POST', `/v1/calls/${inc.call.id}/token`, { token: b.accessToken })).status, 403, 'cannot get token before joining');
  wb.send({ type: 'call:accept', callId: inc.call.id });
  await wb.waitFor('call:joined');
  const mesh = await t.api('POST', `/v1/calls/${inc.call.id}/token`, { token: b.accessToken });
  assert.equal(mesh.body.provider, 'mesh'); assert.ok(mesh.body.iceServers.length);
  wa.send({ type: 'call:end', callId: inc.call.id });
  await wb.waitFor('call:ended');
  await wa.close(); await wb.close();

  const lk = await startApp({ video: { livekitUrl: 'wss://lk.example', livekitKey: 'KEY', livekitSecret: 'SECRET', tokenTtlSec: 600, iceServers: [] } });
  const call = { id: 'c1', roomId: 'room_1', type: 'video' };
  const info = lk.app.video.joinInfo(lk.app.sap.backend.users.get('APP00002'), call);
  await lk.stop();
  assert.equal(info.provider, 'livekit');
  const payload = JSON.parse(Buffer.from(info.token.split('.')[1], 'base64url').toString());
  assert.equal(payload.iss, 'KEY'); assert.equal(payload.sub, 'APP00002'); assert.equal(payload.video.room, 'room_1'); assert.ok(payload.exp - payload.iat <= 600);
  assert.ok(!JSON.stringify(info).includes('SECRET'));
});
