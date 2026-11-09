import crypto from 'node:crypto';
import { HttpError } from '../lib/http.js';

// Call state machine: created -> ringing -> accepted -> active -> ended
// Alternative endings: rejected, cancelled, missed (ring timeout), failed.
const TRANSITIONS = {
  created: ['ringing', 'failed'],
  ringing: ['accepted', 'rejected', 'cancelled', 'missed', 'failed'],
  accepted: ['active', 'ended', 'failed'],
  active: ['ended', 'failed'],
};
const TERMINAL = new Set(['ended', 'rejected', 'cancelled', 'missed', 'failed']);
const MAX_INVITEES = 7; // mesh topology is practical up to ~8 participants; use the LiveKit SFU beyond that
const MAX_SIGNAL_BYTES = 64 * 1024;

export class CallService {
  constructor({ config, sap, auth, video, notifications, emit, isOnline }) {
    Object.assign(this, { config, sap, auth, video, notifications, emit, isOnline });
    this.calls = new Map();
    this.byUser = new Map(); // userId -> callId (live call, ringing or joined)
    this.idempotency = new Map(); // `${userId}:${key}` -> callId
    this.timers = new Map();
  }

  #t(call, to) {
    if (!TRANSITIONS[call.state]?.includes(to)) throw new HttpError(409, `Invalid call transition ${call.state} -> ${to}`, 'BAD_TRANSITION');
    call.state = to;
  }

  snapshot(call) {
    return {
      id: call.id, roomId: call.roomId, type: call.type, state: call.state, hostId: call.hostId, conversationId: call.conversationId,
      participants: [...call.participants].map(([userId, p]) => ({ userId, joinedAt: p.joinedAt, leftAt: p.leftAt || null })),
      invitees: [...call.invitees].map(([userId, status]) => ({ userId, status })),
      createdAt: call.createdAt, startedAt: call.startedAt || null, endedAt: call.endedAt || null, durationSec: call.durationSec ?? null,
    };
  }

  #joined(call) { return [...call.participants].filter(([, p]) => !p.leftAt).map(([id]) => id); }
  #everyone(call) { return [...new Set([call.hostId, ...call.invitees.keys()])]; }
  #send(ids, msg) { for (const id of ids) this.emit(id, msg); }
  #getCall(callId) {
    const call = this.calls.get(callId);
    if (!call) throw new HttpError(404, 'Call not found');
    return call;
  }
  #involved(call, userId) { return call.hostId === userId || call.invitees.has(userId); }

  async initiate(user, { to, type = 'video', conversationId, idempotencyKey } = {}) {
    this.auth.requirePermission(user, 'call:create');
    if (!Array.isArray(to) || !to.length) throw new HttpError(400, 'Choose at least one person to call');
    const targets = [...new Set(to.map(String))];
    if (targets.includes(user.appUserId)) throw new HttpError(400, 'You cannot call yourself');
    if (targets.length > MAX_INVITEES) throw new HttpError(400, `At most ${MAX_INVITEES} people can be invited`);
    if (!['video', 'audio'].includes(type)) throw new HttpError(400, 'type must be video or audio');

    if (idempotencyKey) {
      const prior = this.idempotency.get(`${user.appUserId}:${idempotencyKey}`);
      if (prior && this.calls.has(prior)) return { call: this.snapshot(this.calls.get(prior)), duplicate: true };
    }
    if (this.byUser.has(user.appUserId)) throw new HttpError(409, 'You are already in a call', 'BUSY');

    for (const id of targets) {
      const u = await this.sap.getUser(id).catch(() => { throw new HttpError(503, 'Directory unavailable'); });
      if (!u || u.status !== 'active') throw new HttpError(404, `User ${id} is not available`);
    }

    const call = {
      id: `call_${crypto.randomBytes(8).toString('hex')}`, roomId: `room_${crypto.randomBytes(8).toString('hex')}`, type, state: 'created',
      hostId: user.appUserId, conversationId: conversationId || null, createdAt: new Date().toISOString(),
      participants: new Map([[user.appUserId, { joinedAt: new Date().toISOString() }]]),
      invitees: new Map(targets.map((id) => [id, 'pending'])),
    };
    this.#t(call, 'ringing');
    this.calls.set(call.id, call);
    this.byUser.set(user.appUserId, call.id);
    if (idempotencyKey) this.idempotency.set(`${user.appUserId}:${idempotencyKey}`, call.id);

    for (const id of targets) {
      if (this.byUser.has(id)) { call.invitees.set(id, 'busy'); continue; } // callee is in another call
      this.byUser.set(id, call.id);
      const payload = { type: 'call:incoming', call: this.snapshot(call), from: { appUserId: user.appUserId, name: user.name } };
      this.emit(id, payload);
      if (!this.isOnline(id)) this.notifications.deliver(id, { kind: 'incoming-call', callId: call.id, from: user.name });
    }
    if (![...call.invitees.values()].includes('pending')) { // everyone busy
      this.#finalize(call, 'rejected');
      return { call: this.snapshot(call) };
    }
    this.timers.set(call.id, setTimeout(() => this.#ringTimeout(call.id), this.config.ringTimeoutMs));
    this.timers.get(call.id).unref?.();
    this.emit(user.appUserId, { type: 'call:ringing', call: this.snapshot(call) });
    return { call: this.snapshot(call) };
  }

  accept(user, callId) {
    const call = this.#getCall(callId);
    const status = call.invitees.get(user.appUserId);
    if (!status) throw new HttpError(403, 'You were not invited to this call');
    if (call.participants.get(user.appUserId) && !call.participants.get(user.appUserId).leftAt) return { call: this.snapshot(call) }; // idempotent
    if (TERMINAL.has(call.state)) throw new HttpError(409, 'Call has already ended', 'CALL_ENDED');
    if (status !== 'pending') throw new HttpError(409, `Cannot accept: invitation is ${status}`);

    const peers = this.#joined(call);
    call.invitees.set(user.appUserId, 'accepted');
    call.participants.set(user.appUserId, { joinedAt: new Date().toISOString() });
    if (call.state === 'ringing') { this.#t(call, 'accepted'); }
    if (call.state === 'accepted') { this.#t(call, 'active'); call.startedAt = new Date().toISOString(); }

    // The newcomer creates the WebRTC offers to the peers already in the call.
    this.emit(user.appUserId, { type: 'call:joined', call: this.snapshot(call), peers });
    this.#send(peers, { type: 'call:participant_joined', callId, userId: user.appUserId, call: this.snapshot(call) });
    return { call: this.snapshot(call) };
  }

  reject(user, callId) {
    const call = this.#getCall(callId);
    if (call.invitees.get(user.appUserId) !== 'pending') {
      if (call.invitees.has(user.appUserId)) return { call: this.snapshot(call) }; // idempotent
      throw new HttpError(403, 'You were not invited to this call');
    }
    call.invitees.set(user.appUserId, 'rejected');
    this.#release(user.appUserId, call.id);
    this.#send(this.#joined(call), { type: 'call:rejected', callId, userId: user.appUserId });
    if (call.state === 'ringing' && ![...call.invitees.values()].includes('pending')) this.#finalize(call, 'rejected');
    return { call: this.snapshot(call) };
  }

  cancel(user, callId) {
    const call = this.#getCall(callId);
    if (call.hostId !== user.appUserId) throw new HttpError(403, 'Only the caller can cancel');
    if (TERMINAL.has(call.state)) return { call: this.snapshot(call) };
    if (call.state !== 'ringing') throw new HttpError(409, 'Call already started; use leave or end');
    this.#finalize(call, 'cancelled');
    return { call: this.snapshot(call) };
  }

  /** Leave the call. The call ends automatically when fewer than two people remain. */
  leave(user, callId) {
    const call = this.#getCall(callId);
    if (!this.#involved(call, user.appUserId)) throw new HttpError(403, 'Not part of this call');
    if (TERMINAL.has(call.state)) return { call: this.snapshot(call) };
    if (call.state === 'ringing' && call.hostId === user.appUserId) { this.#finalize(call, 'cancelled'); return { call: this.snapshot(call) }; }
    const p = call.participants.get(user.appUserId);
    if (!p || p.leftAt) return { call: this.snapshot(call) };
    p.leftAt = new Date().toISOString();
    this.#release(user.appUserId, call.id);
    this.#send(this.#joined(call), { type: 'call:participant_left', callId, userId: user.appUserId });
    const stillRinging = [...call.invitees.values()].includes('pending');
    if (this.#joined(call).length < 2 && !stillRinging) this.#finalize(call, 'ended');
    else if (this.#joined(call).length === 0) this.#finalize(call, 'ended');
    return { call: this.snapshot(call) };
  }

  /** Host ends the call for everyone. In a 1:1 call either side may end it. */
  end(user, callId) {
    const call = this.#getCall(callId);
    if (!this.#involved(call, user.appUserId)) throw new HttpError(403, 'Not part of this call');
    if (TERMINAL.has(call.state)) return { call: this.snapshot(call) };
    if (call.hostId !== user.appUserId && call.invitees.size > 1) throw new HttpError(403, 'Only the host can end the call for everyone');
    if (call.state === 'ringing') { this.#finalize(call, call.hostId === user.appUserId ? 'cancelled' : 'rejected'); return { call: this.snapshot(call) }; }
    this.#finalize(call, 'ended');
    return { call: this.snapshot(call) };
  }

  signal(user, callId, to, data) {
    const call = this.#getCall(callId);
    if (!this.#involved(call, user.appUserId)) throw new HttpError(403, 'Not part of this call');
    if (call.state !== 'active') throw new HttpError(409, 'Call is not active');
    const joined = this.#joined(call);
    if (!joined.includes(user.appUserId) || !joined.includes(to)) throw new HttpError(403, 'Both peers must be in the call');
    if (JSON.stringify(data ?? null).length > MAX_SIGNAL_BYTES) throw new HttpError(413, 'Signal too large');
    this.emit(to, { type: 'rtc:signal', callId, from: user.appUserId, data });
  }

  joinInfo(user, callId) {
    const call = this.#getCall(callId);
    if (!this.#joined(call).includes(user.appUserId) || TERMINAL.has(call.state)) throw new HttpError(403, 'Join the call first');
    return this.video.joinInfo(user, call);
  }

  get(user, callId) {
    const call = this.#getCall(callId);
    if (!this.#involved(call, user.appUserId)) throw new HttpError(404, 'Call not found');
    return this.snapshot(call);
  }

  activeFor(userId) {
    const id = this.byUser.get(userId);
    return id ? this.snapshot(this.calls.get(id)) : null;
  }

  history(user) {
    return [...this.calls.values()]
      .filter((c) => TERMINAL.has(c.state) && this.#involved(c, user.appUserId))
      .map((c) => this.snapshot(c))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Called by the realtime hub when a user's last socket closes. */
  onUserOffline(userId) {
    const callId = this.byUser.get(userId);
    const call = callId && this.calls.get(callId);
    if (!call || TERMINAL.has(call.state)) return;
    const fake = { appUserId: userId };
    try {
      if (call.invitees.get(userId) === 'pending') this.reject(fake, callId);
      else this.leave(fake, callId);
    } catch { /* already gone */ }
  }

  #release(userId, callId) { if (this.byUser.get(userId) === callId) this.byUser.delete(userId); }

  #ringTimeout(callId) {
    const call = this.calls.get(callId);
    if (!call || TERMINAL.has(call.state)) return;
    for (const [id, st] of call.invitees) {
      if (st !== 'pending') continue;
      call.invitees.set(id, 'missed');
      this.#release(id, call.id);
      this.emit(id, { type: 'call:missed', callId });
    }
    if (call.state === 'ringing') this.#finalize(call, 'missed');
  }

  #finalize(call, state) {
    if (TERMINAL.has(call.state)) return;
    this.#t(call, state);
    clearTimeout(this.timers.get(call.id)); this.timers.delete(call.id);
    call.endedAt = new Date().toISOString();
    call.durationSec = call.startedAt ? Math.max(0, Math.round((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000)) : 0;
    for (const p of call.participants.values()) if (!p.leftAt) p.leftAt = call.endedAt;
    for (const [id, st] of call.invitees) if (st === 'pending') call.invitees.set(id, state === 'ended' ? 'missed' : state);
    for (const id of this.#everyone(call)) this.#release(id, call.id);
    this.#prune();
    const snap = this.snapshot(call);
    const evt = { ended: 'call:ended', rejected: 'call:rejected_all', cancelled: 'call:cancelled', missed: 'call:missed', failed: 'call:ended' }[state];
    this.#send(this.#everyone(call), { type: evt, callId: call.id, call: snap });
    // Final record goes to SAP asynchronously (queued + retried if SAP is down).
    this.sap.recordCall({
      callId: call.id, roomId: call.roomId, callType: call.invitees.size > 1 ? 'group' : 'one-to-one', initiatedBy: call.hostId,
      startTime: call.startedAt || call.createdAt, endTime: call.endedAt, durationSec: call.durationSec, status: state,
      participants: snap.participants.map((p) => ({ appUserId: p.userId, joinTime: p.joinedAt, leaveTime: p.leftAt })),
    });
  }

  /** Keep memory bounded: SAP is the long-term call history, so only recent finished calls stay in RAM. */
  #prune() {
    const finished = [...this.calls.values()].filter((c) => TERMINAL.has(c.state));
    if (finished.length <= 500) return;
    for (const c of finished.slice(0, finished.length - 500)) {
      this.calls.delete(c.id);
      for (const [k, v] of this.idempotency) if (v === c.id) this.idempotency.delete(k);
    }
  }

  close() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
