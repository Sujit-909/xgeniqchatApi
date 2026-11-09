export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || `E${status}`; }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler) {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return { pathMatched };
  }
}

export async function readJson(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Payload too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object') throw new Error();
    return v;
  } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

export class RateLimiter {
  constructor({ windowMs, max }) { this.windowMs = windowMs; this.max = max; this.hits = new Map(); }
  check(key, max = this.max) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now - e.start >= this.windowMs) { e = { start: now, count: 0 }; this.hits.set(key, e); }
    e.count++;
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    return { ok: e.count <= max, retryAfterSec: Math.ceil((e.start + this.windowMs - now) / 1000) };
  }
}
