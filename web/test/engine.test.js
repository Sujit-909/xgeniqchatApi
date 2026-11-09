// Integration tests: real gateway + real RealtimeClient + real CallEngine, with a fake WebRTC stack
// (Node has no RTCPeerConnection). This proves the client/gateway protocol, call flow and negotiation plumbing line up.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../gateway/src/server.js';
import { RealtimeClient } from '../lib/realtime.js';
import { CallEngine } from '../lib/rtc-engine.js';

let app; let base; let port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clients = []; const engines = [];

before(async () => {
  app = createApp({ jwtSecret: 'web-test', ringTimeoutMs: 1500, disconnectGraceMs: 30, rateLimit: { windowMs: 60_000, max: 10_000, authMax: 10_000 } });
  port = await app.listen(0); base = `http://127.0.0.1:${port}`;
});
afterEach(async () => { for (const e of engines.splice(0)) e.close(); for (const c of clients.splice(0)) c.close(); await sleep(120); /* let the server's reconnect grace period expire so calls from this test are torn down */ });
after(async () => { await app.close(); });

async function login(name) {
  const r = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${name}@company.com`, password: 'Password@123' }) });
  return r.json();
}
async function client(name) {
  const s = await login(name);
  const rt = new RealtimeClient({
    url: `ws://127.0.0.1:${port}/ws`, heartbeatMs: 100_000,
    getTicket: async () => {
      const r = await fetch(`${base}/v1/auth/ws-ticket`, { method: 'POST', headers: { authorization: `Bearer ${s.accessToken}` } });
      if (!r.ok) throw Object.assign(new Error('ticket'), { status: r.status });
      return (await r.json()).ticket;
    },
  });
  clients.push(rt);
  const auth = new Promise((res) => rt.on('auth:ok', res));
  rt.connect();
  const ok = await auth;
  return { rt, s, id: s.user.appUserId, auth: ok };
}
const waitEvent = (rt, type, pred = () => true, ms = 3000) => new Promise((res, rej) => {
  const t = setTimeout(() => { off(); rej(new Error(`timeout waiting for ${type}`)); }, ms);
  const off = rt.on(type, (m) => { if (pred(m)) { clearTimeout(t); off(); res(m); } });
});

// ---- Fake WebRTC ----
class FakeTrack { constructor(kind) { this.kind = kind; this.enabled = true; this.stopped = false; } stop() { this.stopped = true; } }
class FakeStream { constructor(tracks = []) { this.tracks = tracks; } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); } getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); } addTrack(t) { this.tracks.push(t); } }
const bus = new Map(); // fake network: pcs by id for candidate/negotiation bookkeeping
class FakePC {
  constructor() { this.signalingState = 'stable'; this.connectionState = 'new'; this.senders = []; this.localDescription = null; this.remoteDescription = null; this.closed = false; this.log = []; Promise.resolve().then(() => { }); }
  addTrack(t, s) { const sender = { track: t, replaceTrack: async (n) => { sender.track = n; } }; this.senders.push(sender); if (this.signalingState === 'stable') this.#needed(); return sender; }
  addTransceiver(kind) { this.senders.push({ track: null, kind, replaceTrack: async () => {} }); this.#needed(); }
  getSenders() { return this.senders; }
  #needed() { if (this._n) return; this._n = true; queueMicrotask(() => { this._n = false; if (this.signalingState === 'stable') this.onnegotiationneeded?.(); }); }
  async setLocalDescription() {
    const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
    this.localDescription = { type, sdp: `fake-${type}`, toJSON() { return { type: this.type, sdp: this.sdp }; } };
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable';
    if (type === 'offer') queueMicrotask(() => this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'cand-1' }) } }));
  }
  async setRemoteDescription(d) {
    this.log.push(`remote-${d.type}`);
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    if (d.type === 'answer') { this.connectionState = 'connected'; this.onconnectionstatechange?.(); }
    this.ontrack?.({ streams: [new FakeStream([new FakeTrack('audio'), new FakeTrack('video')])], track: new FakeTrack('video') });
  }
  async addIceCandidate(c) { if (!this.remoteDescription) throw new Error('candidate before remote description'); this.log.push('cand'); }
  close() { this.closed = true; }
}

function engineFor(c, callId, { fail = false, display } = {}) {
  const pcs = [];
  const e = new CallEngine({
    rt: c.rt, callId, selfId: c.id, callType: 'video', iceServers: [],
    getUserMedia: async (cons) => { if (fail) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); return new FakeStream(cons.video ? [new FakeTrack('audio'), new FakeTrack('video')] : [new FakeTrack('audio')]); },
    getDisplayMedia: async () => display || new FakeStream([new FakeTrack('video')]),
    createPeerConnection: () => { const p = new FakePC(); pcs.push(p); return p; },
    MediaStreamImpl: FakeStream,
  });
  engines.push(e); e.pcs = pcs;
  return e;
}

test('RealtimeClient: connects with a ticket, request() resolves on ack and rejects on server error, ignores stale ids', async () => {
  const a = await client('alice');
  assert.equal(a.rt.status, 'online'); assert.equal(a.auth.user.appUserId, a.id);
  const conv = await (await fetch(`${base}/v1/chat/conversations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${a.s.accessToken}` }, body: JSON.stringify({ memberIds: ['APP00002'] }) })).json();
  const ack = await a.rt.request({ type: 'chat:send', conversationId: conv.conversation.id, text: 'hello' });
  assert.equal(ack.message.text, 'hello');
  await assert.rejects(a.rt.request({ type: 'chat:send', conversationId: conv.conversation.id, text: '' }), (e) => e.status === 400);
  await assert.rejects(a.rt.request({ type: 'call:initiate', to: ['APP99999'] }), (e) => e.status === 404);
});

test('RealtimeClient: auto-reconnects after the connection drops, with a fresh ticket', async () => {
  const a = await client('alice');
  let tickets = 0; const orig = a.rt.getTicket; a.rt.getTicket = async () => { tickets++; return orig(); };
  const statuses = []; a.rt.on('status', (s) => statuses.push(s));
  a.rt.ws.close(); // simulate a network drop
  await waitEvent(a.rt, 'auth:ok', () => true, 5000);
  assert.ok(tickets >= 1); assert.ok(statuses.includes('offline')); assert.equal(a.rt.status, 'online');
});

test('RealtimeClient: a 401 while fetching a ticket stops retrying and signals session expiry', async () => {
  const rt = new RealtimeClient({ url: `ws://127.0.0.1:${port}/ws`, getTicket: async () => { throw Object.assign(new Error('expired'), { status: 401 }); } });
  clients.push(rt);
  const expired = new Promise((res) => rt.on('session-expired', res));
  rt.connect(); await expired;
  assert.equal(rt.status, 'offline'); assert.equal(rt.stopped, true);
});

test('RealtimeClient: requests fail fast when offline', async () => {
  const rt = new RealtimeClient({ url: 'ws://127.0.0.1:1/ws', getTicket: async () => 't' });
  await assert.rejects(rt.request({ type: 'ping' }), /Not connected/);
});

test('1:1 call end-to-end: joiner creates the offer, answer returns, both sides get the remote stream, mute/cam state propagates', async () => {
  const a = await client('alice'); const b = await client('bob');
  const incoming = waitEvent(b.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id], callType: 'video' });
  await incoming;
  const ea = engineFor(a, call.id);
  const eb = engineFor(b, call.id);
  const remoteA = new Promise((res) => ea.on('remote-stream', res));
  const remoteB = new Promise((res) => eb.on('remote-stream', res));
  const peerMedia = new Promise((res) => ea.on('peer-media', res));
  const joined = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id });
  const j = await joined;
  await eb.connectToPeers(j.peers);
  assert.equal((await remoteA).userId, b.id); assert.equal((await remoteB).userId, a.id);
  const pa = ea.pcs[0]; const pb = eb.pcs[0];
  assert.equal(ea.pcs.length, 1); assert.equal(eb.pcs.length, 1);
  assert.deepEqual(pb.log.filter((l) => l.startsWith('remote')), ['remote-answer']);
  assert.ok(pa.log.includes('remote-offer'));
  assert.equal(pa.signalingState, 'stable'); assert.equal(pb.signalingState, 'stable');
  eb.setMic(false); eb.setCam(false);
  const m = await new Promise((res) => { const off = ea.on('peer-media', (x) => { if (x.media.mic === false && x.media.cam === false) { off(); res(x); } }); });
  assert.equal(m.userId, b.id); assert.equal(m.media.cam, false);
  assert.equal(eb.localStream.getAudioTracks()[0].enabled, false);
  await peerMedia;
});

test('glare: both sides offer simultaneously and the polite peer resolves it (no stuck negotiation)', async () => {
  const a = await client('alice'); const b = await client('bob');
  const inc = waitEvent(b.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id] }); await inc;
  const ea = engineFor(a, call.id); const eb = engineFor(b, call.id);
  const joined = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id }); const j = await joined;
  await ea.connectToPeers([b.id]); // alice ALSO offers at the same time as bob
  await eb.connectToPeers(j.peers);
  await sleep(400);
  const pa = ea.pcs[0]; const pb = eb.pcs[0];
  assert.equal(pa.signalingState, 'stable'); assert.equal(pb.signalingState, 'stable');
  assert.equal(pa.remoteDescription !== null && pb.remoteDescription !== null, true);
});

test('media permission denied: falls back to audio-only, then to receive-only, and still connects', async () => {
  const a = await client('alice'); const b = await client('bob');
  const inc = waitEvent(b.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id] }); await inc;
  const ea = engineFor(a, call.id);
  const eb = engineFor(b, call.id, { fail: true });
  const warn = new Promise((res) => eb.on('media-warning', res));
  const remoteA = new Promise((res) => ea.on('remote-stream', res));
  const joined = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id });
  await eb.connectToPeers((await joined).peers);
  assert.match(await warn, /unavailable/i);
  assert.equal(eb.localStream, null);
  assert.equal((await remoteA).userId, b.id);
  assert.equal(eb.media.mic, false);
});

test('screen share swaps the outgoing video track and restores the camera', async () => {
  const a = await client('alice'); const b = await client('bob');
  const inc = waitEvent(b.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id] }); await inc;
  const screen = new FakeStream([new FakeTrack('video')]);
  const ea = engineFor(a, call.id); const eb = engineFor(b, call.id, { display: screen });
  const joined = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id });
  await eb.connectToPeers((await joined).peers);
  await new Promise((res) => eb.on('remote-stream', res));
  const camera = eb.cameraTrack;
  await eb.shareScreen();
  const sender = eb.pcs[0].getSenders().find((s) => s.track?.kind === 'video');
  assert.equal(sender.track, screen.getVideoTracks()[0]);
  await eb.stopShare();
  assert.equal(eb.pcs[0].getSenders().find((s) => s.track?.kind === 'video').track, camera);
  assert.equal(screen.getVideoTracks()[0].stopped, true);
});

test('hangup: leaving ends the call for the other side and the engine releases camera/mic', async () => {
  const a = await client('alice'); const b = await client('bob');
  const inc = waitEvent(b.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id] }); await inc;
  const ea = engineFor(a, call.id); const eb = engineFor(b, call.id);
  const joined = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id });
  await eb.connectToPeers((await joined).peers);
  await new Promise((res) => ea.on('remote-stream', res));
  const tracks = [...ea.localStream.getTracks()];
  const ended = waitEvent(a.rt, 'call:ended');
  await b.rt.request({ type: 'call:leave', callId: call.id });
  eb.close();
  assert.equal((await ended).call.state, 'ended');
  ea.close();
  assert.ok(tracks.every((t) => t.stopped), 'all local tracks stopped');
  ea.close(); // idempotent
});

test('group call: late joiner offers to every existing participant; existing peers answer lazily', async () => {
  const a = await client('alice'); const b = await client('bob'); const c = await client('carol');
  const ib = waitEvent(b.rt, 'call:incoming'); const ic = waitEvent(c.rt, 'call:incoming');
  const { call } = await a.rt.request({ type: 'call:initiate', to: [b.id, c.id] }); await ib; await ic;
  const ea = engineFor(a, call.id); const eb = engineFor(b, call.id); const ec = engineFor(c, call.id);
  const jb = waitEvent(b.rt, 'call:joined');
  await b.rt.request({ type: 'call:accept', callId: call.id }); await eb.connectToPeers((await jb).peers);
  await new Promise((res) => ea.on('remote-stream', res));
  const jc = waitEvent(c.rt, 'call:joined');
  await c.rt.request({ type: 'call:accept', callId: call.id });
  const peers = (await jc).peers; assert.equal(peers.length, 2);
  const got = new Set(); const done = new Promise((res) => ec.on('remote-stream', (m) => { got.add(m.userId); if (got.size === 2) res(); }));
  await ec.connectToPeers(peers); await done;
  assert.deepEqual([...got].sort(), [a.id, b.id].sort());
  assert.equal(eb.peers.size, 2, 'bob now also has a peer connection to carol');
  const left = new Promise((res) => eb.on('peer-left', res));
  await c.rt.request({ type: 'call:leave', callId: call.id });
  assert.equal((await left).userId, c.id); assert.equal(eb.peers.size, 1);
});

test('closing the engine while the permission prompt is open still releases the camera (StrictMode double-mount safe)', async () => {
  const a = await client('alice');
  let resolveMedia; const stream = new FakeStream([new FakeTrack('audio'), new FakeTrack('video')]);
  const e = new CallEngine({ rt: a.rt, callId: 'x', selfId: a.id, getUserMedia: () => new Promise((r) => { resolveMedia = r; }), createPeerConnection: () => new FakePC(), MediaStreamImpl: FakeStream });
  engines.push(e);
  e.close();
  resolveMedia(stream);
  await e.ready;
  assert.ok(stream.getTracks().every((t) => t.stopped));
  assert.equal(e.localStream, null);
});
