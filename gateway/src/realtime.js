import { HttpError } from './lib/http.js';

/** Realtime hub: sockets, presence, chat and call signaling events. */
export class RealtimeHub {
  constructor({ auth, chat, sap, getCalls, config }) {
    Object.assign(this, { auth, chat, sap, getCalls, config });
    this.sockets = new Map(); // userId -> Set<conn>
    this.graceTimers = new Map(); // userId -> timer (pending call teardown after a disconnect)
  }

  close() { for (const t of this.graceTimers.values()) clearTimeout(t); this.graceTimers.clear(); }

  isOnline(userId) { return (this.sockets.get(userId)?.size || 0) > 0; }
  onlineIds() { return [...this.sockets.keys()]; }

  emit(userId, msg) {
    const set = this.sockets.get(userId);
    if (!set) return;
    const data = JSON.stringify(msg);
    for (const c of set) c.send(data);
  }

  broadcast(msg) { for (const id of this.sockets.keys()) this.emit(id, msg); }

  handleConnection(conn) {
    let user = null;
    let authing = false;
    const authTimer = setTimeout(() => { if (!user) conn.close(4401, 'auth timeout'); }, 5000);
    authTimer.unref?.();
    const bucket = { n: 0, start: Date.now() };

    conn.on('message', async (raw) => {
      // Per-socket flood protection: 60 messages/second burst budget.
      if (Date.now() - bucket.start > 1000) { bucket.n = 0; bucket.start = Date.now(); }
      if (++bucket.n > 60) { conn.close(4429, 'rate limit'); return; }
      let msg;
      try { msg = JSON.parse(raw); } catch { return conn.send({ type: 'error', error: 'Invalid JSON' }); }
      if (!msg || typeof msg.type !== 'string') return conn.send({ type: 'error', error: 'Missing type' });

      if (!user) {
        if (msg.type !== 'auth') return conn.close(4401, 'auth required');
        if (authing) return;
        authing = true;
        try {
          user = msg.ticket ? await this.auth.redeemWsTicket(msg.ticket) : await this.auth.authenticate(msg.token);
        } catch (e) { conn.send({ type: 'auth:error', error: e.message }); return conn.close(4401, 'unauthorized'); }
        clearTimeout(authTimer);
        if (conn.closed) return;
        this.#register(user, conn);
        return;
      }

      try { await this.#dispatch(user, conn, msg); }
      catch (e) {
        const known = e instanceof HttpError;
        if (!known) console.error('ws handler error', e);
        conn.send({ type: 'error', ref: msg.type, requestId: msg.requestId, status: known ? e.status : 500, code: known ? e.code : 'INTERNAL', error: known ? e.message : 'Internal error' });
      }
    });

    conn.on('close', () => {
      clearTimeout(authTimer);
      if (user) this.#unregister(user, conn);
    });
  }

  #register(user, conn) {
    clearTimeout(this.graceTimers.get(user.appUserId)); this.graceTimers.delete(user.appUserId); // reconnected in time: keep the call
    let set = this.sockets.get(user.appUserId);
    const first = !set;
    if (!set) { set = new Set(); this.sockets.set(user.appUserId, set); }
    set.add(conn);
    conn.send({ type: 'auth:ok', user: { appUserId: user.appUserId, name: user.name, role: user.role }, online: this.onlineIds(), activeCall: this.getCalls().activeFor(user.appUserId) });
    if (first) this.broadcast({ type: 'user:online', userId: user.appUserId });
  }

  #unregister(user, conn) {
    const set = this.sockets.get(user.appUserId);
    if (!set) return;
    set.delete(conn);
    if (set.size) return;
    this.sockets.delete(user.appUserId);
    this.broadcast({ type: 'user:offline', userId: user.appUserId });
    // Only tear down the user's call if they do not come back within the grace period.
    const timer = setTimeout(() => {
      this.graceTimers.delete(user.appUserId);
      if (!this.isOnline(user.appUserId)) this.getCalls().onUserOffline(user.appUserId);
    }, this.config.disconnectGraceMs);
    timer.unref?.();
    this.graceTimers.set(user.appUserId, timer);
  }

  async #dispatch(user, conn, msg) {
    const calls = this.getCalls();
    const ack = (extra = {}) => conn.send({ type: 'ack', ref: msg.type, requestId: msg.requestId, ...extra });
    switch (msg.type) {
      case 'ping': return conn.send({ type: 'pong', t: msg.t });
      case 'chat:send': {
        this.auth.requirePermission(user, 'chat:use');
        const { message, conversation, duplicate } = this.chat.send(user.appUserId, msg.conversationId, msg.text, msg.clientId);
        ack({ message });
        if (!duplicate) for (const id of conversation.memberIds) this.emit(id, { type: 'chat:message', message });
        return;
      }
      case 'chat:typing': {
        const conv = this.chat.getConversation(user.appUserId, msg.conversationId);
        for (const id of conv.memberIds) if (id !== user.appUserId) this.emit(id, { type: 'chat:typing', conversationId: conv.id, userId: user.appUserId });
        return;
      }
      case 'chat:read': this.chat.markRead(user.appUserId, msg.conversationId); return ack();
      case 'call:initiate': return ack(await calls.initiate(user, { to: msg.to, type: msg.callType, conversationId: msg.conversationId, idempotencyKey: msg.idempotencyKey }));
      case 'call:accept': return ack(calls.accept(user, msg.callId));
      case 'call:reject': return ack(calls.reject(user, msg.callId));
      case 'call:cancel': return ack(calls.cancel(user, msg.callId));
      case 'call:leave': return ack(calls.leave(user, msg.callId));
      case 'call:end': return ack(calls.end(user, msg.callId));
      case 'rtc:signal': return calls.signal(user, msg.callId, msg.to, msg.data);
      case 'ai:transcription': { // optional live transcript lines, fanned out to call participants
        const call = calls.get(user, msg.callId);
        for (const p of call.participants) if (!p.leftAt && p.userId !== user.appUserId) this.emit(p.userId, { type: 'ai:transcription', callId: call.id, userId: user.appUserId, text: String(msg.text || '').slice(0, 1000) });
        return;
      }
      default: throw new HttpError(400, `Unknown event: ${msg.type}`);
    }
  }
}
