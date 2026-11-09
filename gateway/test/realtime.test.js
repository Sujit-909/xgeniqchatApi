import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, openSocket } from './helpers.js';

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.stop(); });
afterEach(async () => { await t.reset(); }); // a failed test must never leak sockets/state into the next one
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ws: ticket auth works once; replay, bad token, no auth and wrong first message are rejected', async () => {
  const a = await t.login('alice');
  const tk = (await t.api('POST', '/v1/auth/ws-ticket', { token: a.accessToken })).body.ticket;
  const ok = await openSocket(`ws://127.0.0.1:${t.port}/ws`, { ticket: tk });
  assert.equal(ok.authMsg.type, 'auth:ok'); assert.equal(ok.authMsg.user.appUserId, a.id);
  const replay = await openSocket(`ws://127.0.0.1:${t.port}/ws`, { ticket: tk });
  await sleep(100); assert.equal(replay.closedCode, 4401);
  const bad = await openSocket(`ws://127.0.0.1:${t.port}/ws`, { token: 'garbage' });
  await sleep(100); assert.equal(bad.closedCode, 4401);
  const none = await openSocket(`ws://127.0.0.1:${t.port}/ws`);
  none.send({ type: 'chat:send' });
  await sleep(100); assert.equal(none.closedCode, 4401);
  const viaToken = await openSocket(`ws://127.0.0.1:${t.port}/ws`, { token: a.accessToken });
  assert.equal(viaToken.authMsg.type, 'auth:ok');
  await ok.close(); await viaToken.close();
});

test('ws: presence events and online list', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a);
  const wb = await t.connect(b);
  const online = await wa.waitFor((m) => m.type === 'user:online' && m.userId === b.id);
  assert.equal(online.userId, b.id);
  await wb.close();
  assert.equal((await wa.waitFor('user:offline')).userId, b.id);
  await wa.close();
});

test('ws: chat message fan-out, typing, ack, idempotent clientId, large (>64KB frame header path) payload handled', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const conv = (await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id] } })).body.conversation;
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'chat:send', conversationId: conv.id, text: 'hi bob', clientId: 'c1', requestId: 'r1' });
  const ack = await wa.ack('chat:send');
  assert.equal(ack.requestId, 'r1');
  const got = await wb.waitFor('chat:message');
  assert.equal(got.message.text, 'hi bob'); assert.equal(got.message.senderId, a.id);
  wa.send({ type: 'chat:send', conversationId: conv.id, text: 'hi bob', clientId: 'c1' });
  await wa.ack('chat:send');
  assert.equal(await wb.expectNone('chat:message'), true, 'duplicate not re-broadcast');
  wa.send({ type: 'chat:typing', conversationId: conv.id });
  assert.equal((await wb.waitFor('chat:typing')).userId, a.id);
  wa.send({ type: 'chat:send', conversationId: conv.id, text: 'x'.repeat(5000) });
  assert.equal((await wa.waitFor('error')).status, 400);
  wa.ws.send(JSON.stringify({ type: 'ping', pad: 'p'.repeat(70_000), t: 5 }));
  assert.equal((await wa.waitFor('pong')).t, 5);
  wa.ws.send('not json');
  assert.equal((await wa.waitFor('error')).error, 'Invalid JSON');
  wa.send({ type: 'wat' });
  assert.equal((await wa.waitFor('error')).status, 400);
  await wa.close(); await wb.close();
});

test('ws: message to a conversation you are not in is refused', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  const conv = (await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id] } })).body.conversation;
  const wc = await t.connect(c);
  wc.send({ type: 'chat:send', conversationId: conv.id, text: 'sneaky' });
  assert.equal((await wc.waitFor('error')).status, 404);
  await wc.close();
});

test('call: full 1:1 flow with WebRTC signal relay, duration and history', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id], callType: 'video', requestId: 'i' });
  const ack = await wa.ack('call:initiate');
  const callId = ack.call.id;
  assert.equal(ack.call.state, 'ringing');
  const inc = await wb.waitFor('call:incoming');
  assert.equal(inc.call.id, callId); assert.equal(inc.from.appUserId, a.id);
  wa.send({ type: 'rtc:signal', callId, to: b.id, data: { sdp: 'early' } });
  assert.equal((await wa.waitFor('error')).status, 409, 'no signaling before the call is active');
  wb.send({ type: 'call:accept', callId });
  const joined = await wb.waitFor('call:joined');
  assert.deepEqual(joined.peers, [a.id]); assert.equal(joined.call.state, 'active');
  const pj = await wa.waitFor('call:participant_joined');
  assert.equal(pj.userId, b.id);
  wb.send({ type: 'rtc:signal', callId, to: a.id, data: { type: 'offer', sdp: 'o'.repeat(40_000) } });
  const sig = await wa.waitFor('rtc:signal');
  assert.equal(sig.from, b.id); assert.equal(sig.data.sdp.length, 40_000);
  await sleep(1100);
  wb.send({ type: 'call:leave', callId });
  const ended = await wa.waitFor('call:ended');
  assert.equal(ended.call.state, 'ended'); assert.ok(ended.call.durationSec >= 1);
  await wb.waitFor('call:ended');
  const hist = await t.api('GET', '/v1/calls', { token: a.accessToken });
  assert.equal(hist.body.calls[0].id, callId);
  await sleep(50);
  assert.ok(t.app.sap.backend.calls.has(callId), 'final record written to SAP');
  await wa.close(); await wb.close();
});

test('call: reject, cancel, missed (ring timeout), busy, idempotency, self/unknown/inactive targets', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  const wa = await t.connect(a); const wb = await t.connect(b); const wc = await t.connect(c);

  wa.send({ type: 'call:initiate', to: [b.id] });
  const c1 = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wb.send({ type: 'call:reject', callId: c1 });
  const rej = await wa.waitFor('call:rejected_all');
  assert.equal(rej.call.state, 'rejected');

  wa.send({ type: 'call:initiate', to: [b.id] });
  const c2 = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wa.send({ type: 'call:cancel', callId: c2 });
  assert.equal((await wb.waitFor('call:cancelled')).call.state, 'cancelled');

  wa.send({ type: 'call:initiate', to: [b.id] });
  await wa.ack('call:initiate'); await wb.waitFor('call:incoming');
  assert.equal((await wb.waitFor('call:missed', 2000)).type, 'call:missed');
  assert.equal((await wa.waitFor('call:missed')).call.state, 'missed');

  wa.send({ type: 'call:initiate', to: [b.id], idempotencyKey: 'k1' });
  const first = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wa.send({ type: 'call:initiate', to: [b.id], idempotencyKey: 'k1' });
  const second = await wa.ack('call:initiate');
  assert.equal(second.call.id, first); assert.equal(second.duplicate, true);
  wc.send({ type: 'call:initiate', to: [b.id] }); // bob is already ringing in another call
  const busy = await wc.ack('call:initiate');
  assert.equal(busy.call.state, 'rejected', 'all callees busy -> call rejected immediately');
  wa.send({ type: 'call:cancel', callId: first });
  await wb.waitFor('call:cancelled');

  wa.send({ type: 'call:initiate', to: [a.id] }); assert.equal((await wa.waitFor('error')).status, 400);
  wa.send({ type: 'call:initiate', to: ['APP99999'] }); assert.equal((await wa.waitFor('error')).status, 404);
  wa.send({ type: 'call:initiate', to: ['APP00005'] }); assert.equal((await wa.waitFor('error')).status, 404);
  wa.send({ type: 'call:initiate', to: [] }); assert.equal((await wa.waitFor('error')).status, 400);
  wa.send({ type: 'call:initiate', to: [b.id], callType: 'hologram' }); assert.equal((await wa.waitFor('error')).status, 400);
  await wa.close(); await wb.close(); await wc.close();
});

test('call: duplicate/late events cannot corrupt state', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wb.send({ type: 'call:accept', callId: id }); await wb.waitFor('call:joined');
  assert.equal((await wb.ack('call:accept')).call.state, 'active');
  wb.send({ type: 'call:accept', callId: id }); // duplicate accept: idempotent
  assert.equal((await wb.ack('call:accept')).call.state, 'active');
  assert.equal(await wa.expectNone('call:participant_joined', 50), false, 'only one join event');
  await wa.waitFor('call:participant_joined');
  assert.equal(await wa.expectNone('call:participant_joined'), true, 'duplicate accept does not re-announce');
  wa.send({ type: 'call:cancel', callId: id });
  assert.equal((await wa.waitFor('error')).status, 409, 'cannot cancel an active call');
  wb.send({ type: 'call:reject', callId: id }); // late reject after accept is a no-op
  wa.send({ type: 'call:end', callId: id });
  await wa.waitFor('call:ended');
  wa.send({ type: 'call:end', callId: id }); // double end is idempotent
  wb.send({ type: 'call:accept', callId: id });
  const late = await wb.waitFor((m) => (m.type === 'error' && m.ref === 'call:accept') || (m.type === 'ack' && m.ref === 'call:accept' && m.call.state === 'ended'));
  assert.ok(late.type === 'ack' || late.status === 409);
  await wa.close(); await wb.close();
});

test('call: uninvited users cannot accept, signal, or read a call', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  const wa = await t.connect(a); const wb = await t.connect(b); const wc = await t.connect(c);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wc.send({ type: 'call:accept', callId: id }); assert.equal((await wc.waitFor('error')).status, 403);
  wc.send({ type: 'rtc:signal', callId: id, to: a.id, data: {} }); assert.equal((await wc.waitFor('error')).status, 403);
  assert.equal((await t.api('GET', `/v1/calls/${id}`, { token: c.accessToken })).status, 404);
  wa.send({ type: 'call:cancel', callId: id }); await wb.waitFor('call:cancelled');
  await wa.close(); await wb.close(); await wc.close();
});

test('call: group call, late joiner gets existing peers, call survives until <2 remain, host can end for all', async () => {
  const a = await t.login('alice'); const b = await t.login('bob'); const c = await t.login('carol');
  const wa = await t.connect(a); const wb = await t.connect(b); const wc = await t.connect(c);
  wa.send({ type: 'call:initiate', to: [b.id, c.id] });
  const id = (await wa.ack('call:initiate')).call.id;
  await wb.waitFor('call:incoming'); await wc.waitFor('call:incoming');
  wb.send({ type: 'call:accept', callId: id }); await wb.waitFor('call:joined');
  wc.send({ type: 'call:accept', callId: id });
  const jc = await wc.waitFor('call:joined');
  assert.deepEqual([...jc.peers].sort(), [a.id, b.id].sort());
  assert.equal((await wb.waitFor((m) => m.type === 'call:participant_joined' && m.userId === c.id)).userId, c.id);
  wc.send({ type: 'call:leave', callId: id });
  assert.equal((await wa.waitFor((m) => m.type === 'call:participant_left')).userId, c.id);
  assert.equal(t.app.calls.get({ appUserId: a.id }, id).state, 'active', 'two people remain -> still active');
  wb.send({ type: 'call:end', callId: id });
  assert.equal((await wb.waitFor('error')).status, 403, 'non-host cannot end a group call for everyone');
  wa.send({ type: 'call:end', callId: id });
  assert.equal((await wb.waitFor('call:ended')).call.state, 'ended');
  await wa.close(); await wb.close(); await wc.close();
});

test('call: disconnecting mid-call ends it; invitee going offline while ringing rejects; user freed afterwards', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wb.send({ type: 'call:accept', callId: id }); await wb.waitFor('call:joined');
  await wb.close(); // network drop / tab closed
  assert.equal((await wa.waitFor('call:ended')).call.state, 'ended'); // after the grace period
  const wb2 = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  await wa.ack('call:initiate'); await wb2.waitFor('call:incoming');
  await wb2.close();
  assert.equal((await wa.waitFor('call:rejected_all')).call.state, 'rejected');
  assert.equal(t.app.calls.activeFor(a.id), null);
  await wa.close();
});

test('call: reconnecting user receives their active call in auth:ok', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  const second = await t.connect(a); // second tab / reconnect for the same user
  assert.equal(second.authMsg.activeCall.id, id);
  assert.equal(second.authMsg.activeCall.state, 'ringing');
  await second.close();
  assert.equal(t.app.hub.isOnline(a.id), true);
  wa.send({ type: 'call:cancel', callId: id }); await wb.waitFor('call:cancelled');
  await wa.close(); await wb.close();
});

test('SAP outage does not break calls; record is queued and flushed on recovery', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  t.app.sap.backend.failing = true;
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wb.send({ type: 'call:accept', callId: id }); await wb.waitFor('call:joined');
  wa.send({ type: 'call:end', callId: id }); await wb.waitFor('call:ended');
  await sleep(50);
  assert.equal(t.app.sap.backend.calls.has(id), false);
  assert.ok(t.app.sap.pendingWrites.length >= 1);
  t.app.sap.backend.failing = false; t.app.sap.breaker.failures = 0;
  await t.app.sap.flush();
  assert.equal(t.app.sap.backend.calls.has(id), true, 'queued record synced after recovery');
  await wa.close(); await wb.close();
});

test('REST fan-out: message posted over REST reaches the recipient socket', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const conv = (await t.api('POST', '/v1/chat/conversations', { token: a.accessToken, body: { memberIds: [b.id] } })).body.conversation;
  const wb = await t.connect(b);
  await t.api('POST', `/v1/chat/conversations/${conv.id}/messages`, { token: a.accessToken, body: { text: 'via rest' } });
  assert.equal((await wb.waitFor('chat:message')).message.text, 'via rest');
  await wb.close();
});

test('call: a brief disconnect (network switch) does not end the call if the user reconnects within the grace period', async () => {
  const a = await t.login('alice'); const b = await t.login('bob');
  const wa = await t.connect(a); const wb = await t.connect(b);
  wa.send({ type: 'call:initiate', to: [b.id] });
  const id = (await wa.ack('call:initiate')).call.id; await wb.waitFor('call:incoming');
  wb.send({ type: 'call:accept', callId: id }); await wb.waitFor('call:joined');
  await wb.close(); // Wi-Fi -> mobile data
  await sleep(30);
  const wb2 = await t.connect(b); // reconnect well inside the 100ms test grace
  assert.equal(wb2.authMsg.activeCall.id, id, 'reconnected client is told about its live call');
  assert.equal(wb2.authMsg.activeCall.state, 'active');
  await sleep(250); // grace window passes
  assert.equal(t.app.calls.get({ appUserId: a.id }, id).state, 'active', 'call survived the blip');
  wb2.send({ type: 'rtc:signal', callId: id, to: a.id, data: { hello: 1 } });
  assert.equal((await wa.waitFor('rtc:signal')).from, b.id, 'signaling works again after reconnect');
  wa.send({ type: 'call:end', callId: id }); await wb2.waitFor('call:ended');
});
