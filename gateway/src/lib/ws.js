// Minimal RFC 6455 WebSocket server (text frames, ping/pong, close, fragmentation) with no dependencies.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 1024 * 1024; // 1 MiB per message

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.alive = true;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish());
    socket.on('error', () => this.#finish());
    socket.setNoDelay(true);
  }

  send(data) {
    if (this.closed) return false;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    this.#writeFrame(0x1, payload);
    return true;
  }

  ping() { if (!this.closed) this.#writeFrame(0x9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(reason).subarray(0, 100);
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.#writeFrame(0x8, payload);
    this.socket.end();
    this.#finish(code);
  }

  terminate() { this.socket.destroy(); this.#finish(1006); }

  #finish(code = 1006) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  #writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([header, payload]));
  }

  #fail(code, reason) { this.close(code, reason); }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2); offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.#fail(1009, 'message too big');
        len = Number(big); offset = 10;
      }
      if (len > MAX_PAYLOAD) return this.#fail(1009, 'message too big');
      if (!masked) return this.#fail(1002, 'client frames must be masked');
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = this.buffer.subarray(offset + 4 + len);
      this.#handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  #handleFrame(fin, opcode, payload) {
    if (opcode >= 0x8) { // control frames
      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.#writeFrame(0xa, payload); return; }
      if (opcode === 0xa) { this.alive = true; return; }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2) { this.fragmentOpcode = opcode; this.fragments = [payload]; }
    else if (opcode === 0x0) {
      if (!this.fragments.length) return this.#fail(1002, 'unexpected continuation');
      this.fragments.push(payload);
    } else return this.#fail(1002, 'bad opcode');
    if (this.fragments.reduce((n, f) => n + f.length, 0) > MAX_PAYLOAD) return this.#fail(1009, 'message too big');
    if (!fin) return;
    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.emit('message', full.toString('utf8'));
  }
}

/** Attach to an http.Server; calls onConnection(conn, req) for upgrades on `path`. */
export function attachWebSocket(server, { path = '/ws', allowedOrigins = [], onConnection }) {
  const conns = new Set();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    if (url.pathname !== path || req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (origin && allowedOrigins.length && !allowedOrigins.includes('*') && !allowedOrigins.includes(origin)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    const conn = new WsConnection(socket);
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConnection(conn, req);
  });

  // Heartbeat: drop dead peers so presence stays accurate after network drops.
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 30_000);
  timer.unref();
  return { connections: conns, close() { clearInterval(timer); for (const c of conns) c.close(1001, 'server shutdown'); } };
}
