import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function signJwt(payload, secret, { expiresInSec, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, ...payload };
  if (expiresInSec) body.exp = now + expiresInSec;
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT', ...header }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  return `${data}.${sign(data, secret)}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') throw new Error('invalid token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('invalid token');
  const [h, p, s] = parts;
  let header;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString()); } catch { throw new Error('invalid token'); }
  if (header.alg !== 'HS256') throw new Error('invalid token'); // blocks alg:none / alg confusion
  const expected = Buffer.from(sign(`${h}.${p}`, secret));
  const actual = Buffer.from(s);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('invalid token');
  let payload;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { throw new Error('invalid token'); }
  if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) throw new Error('token expired');
  return payload;
}
