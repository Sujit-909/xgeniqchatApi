// Reconnecting WebSocket client for the gateway. Plain ES module (works in browsers and Node 22+).
// Auth uses a single-use ticket fetched via the Next.js BFF, so no token ever appears in a URL.
export class RealtimeClient {
  constructor({ url, getTicket, WebSocketImpl = globalThis.WebSocket, heartbeatMs = 20_000, maxBackoffMs = 15_000, requestTimeoutMs = 8_000 }) {
    Object.assign(this, { url, getTicket, WebSocketImpl, heartbeatMs, maxBackoffMs, requestTimeoutMs });
    this.listeners = new Map();
    this.pending = new Map();
    this.status = 'idle';
    this.attempts = 0;
    this.stopped = true;
    this.seq = 0;
    this.ws = null;
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  #emit(type, payload) {
    for (const fn of [...(this.listeners.get(type) || [])]) { try { fn(payload); } catch (e) { console.error('listener error', e); } }
  }

  #setStatus(s) { if (this.status !== s) { this.status = s; this.#emit('status', s); } }

  connect() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#open();
  }

  async #open() {
    this.#setStatus('connecting');
    let ticket;
    try { ticket = await this.getTicket(); }
    catch (e) {
      if (e?.status === 401) { this.stopped = true; this.#setStatus('offline'); this.#emit('session-expired', e); return; }
      return this.#retry();
    }
    if (this.stopped) return;
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', ticket }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'auth:ok') { this.attempts = 0; this.#setStatus('online'); this.#startHeartbeat(); }
      if ((msg.type === 'ack' || msg.type === 'error') && msg.requestId && this.pending.has(msg.requestId)) {
        const p = this.pending.get(msg.requestId); this.pending.delete(msg.requestId); clearTimeout(p.timer);
        if (msg.type === 'ack') p.resolve(msg); else p.reject(Object.assign(new Error(msg.error || 'Request failed'), { status: msg.status, code: msg.code }));
      }
      this.#emit(msg.type, msg);
      this.#emit('*', msg);
    };
    ws.onclose = (ev) => {
      clearInterval(this.hb);
      if (this.ws === ws) this.ws = null;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Connection lost')); this.pending.delete(id); }
      this.#setStatus('offline');
      if (!this.stopped) this.#retry();
    };
    ws.onerror = () => {};
  }

  #retry() {
    if (this.stopped) return;
    const delay = Math.min(this.maxBackoffMs, 500 * 2 ** this.attempts++) + Math.random() * 300;
    this.#setStatus('offline');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (!this.stopped) this.#open(); }, delay);
  }

  #startHeartbeat() {
    clearInterval(this.hb);
    this.hb = setInterval(() => this.send({ type: 'ping', t: Date.now() }), this.heartbeatMs);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1 || this.status !== 'online') return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Send an event and resolve with the server's ack (or reject with its error). */
  request(msg, timeoutMs = this.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = `r${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Request timed out')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      if (!this.send({ ...msg, requestId })) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Not connected')); }
    });
  }

  close() {
    this.stopped = true;
    clearTimeout(this.retryTimer); clearInterval(this.hb);
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('Connection closed')); this.pending.delete(id); }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.#setStatus('idle');
  }
}
