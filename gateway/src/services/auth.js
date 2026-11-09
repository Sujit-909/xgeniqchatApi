import crypto from 'node:crypto';
import { signJwt, verifyJwt } from '../lib/jwt.js';
import { HttpError } from '../lib/http.js';
import { publicUser } from './sap.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export class AuthService {
  constructor(config, sap) {
    this.config = config;
    this.sap = sap;
    this.refreshTokens = new Map(); // hash -> { userId, exp }
    this.wsTickets = new Map(); // ticket -> { userId, exp }
  }

  #issue(user) {
    const accessToken = signJwt({ sub: user.appUserId, role: user.role, typ: 'access' }, this.config.jwtSecret, { expiresInSec: this.config.accessTtlSec });
    const refreshToken = crypto.randomBytes(32).toString('base64url');
    this.refreshTokens.set(sha(refreshToken), { userId: user.appUserId, exp: Date.now() + this.config.refreshTtlSec * 1000 });
    return { accessToken, refreshToken, expiresIn: this.config.accessTtlSec, user: publicUser(user) };
  }

  async login(email, password) {
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) throw new HttpError(400, 'Email and password are required');
    let user;
    try { user = await this.sap.verifyCredentials(email, password); } catch { throw new HttpError(503, 'Identity service unavailable'); }
    if (!user) throw new HttpError(401, 'Invalid email or password');
    if (user.status !== 'active') throw new HttpError(403, 'Account is deactivated');
    return this.#issue(user);
  }

  async refresh(refreshToken) {
    const key = sha(String(refreshToken || ''));
    const rec = this.refreshTokens.get(key);
    if (!rec || rec.exp < Date.now()) { this.refreshTokens.delete(key); throw new HttpError(401, 'Invalid refresh token'); }
    this.refreshTokens.delete(key); // rotation: each refresh token works once
    const user = await this.sap.getUser(rec.userId, { fresh: true }).catch(() => null);
    if (!user || user.status !== 'active') throw new HttpError(401, 'Account is not active');
    return this.#issue(user);
  }

  logout(refreshToken) { if (refreshToken) this.refreshTokens.delete(sha(String(refreshToken))); }

  revokeUser(userId) {
    for (const [k, v] of this.refreshTokens) if (v.userId === userId) this.refreshTokens.delete(k);
    for (const [k, v] of this.wsTickets) if (v.userId === userId) this.wsTickets.delete(k);
    this.sap.invalidate(userId);
  }

  /** Verifies an access token AND that the SAP user is still active (deactivation takes effect within the cache TTL). */
  async authenticate(token) {
    let payload;
    try { payload = verifyJwt(token, this.config.jwtSecret); } catch { throw new HttpError(401, 'Invalid or expired token'); }
    if (payload.typ !== 'access') throw new HttpError(401, 'Invalid token type');
    let user;
    try { user = await this.sap.getUser(payload.sub); } catch { throw new HttpError(503, 'Identity service unavailable'); }
    if (!user || user.status !== 'active') throw new HttpError(401, 'Account is not active');
    return user;
  }

  can(user, permission) {
    return user.permissions.includes(permission) || user.role === 'admin';
  }

  requirePermission(user, permission) {
    if (!this.can(user, permission)) throw new HttpError(403, `Missing permission: ${permission}`);
  }

  /** Single-use, 60 s ticket so browsers can open a WebSocket without the access token in a URL. */
  createWsTicket(user) {
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.wsTickets.set(ticket, { userId: user.appUserId, exp: Date.now() + this.config.wsTicketTtlSec * 1000 });
    if (this.wsTickets.size > 5000) for (const [k, v] of this.wsTickets) if (v.exp < Date.now()) this.wsTickets.delete(k);
    return { ticket, expiresIn: this.config.wsTicketTtlSec };
  }

  async redeemWsTicket(ticket) {
    const rec = this.wsTickets.get(ticket);
    this.wsTickets.delete(ticket);
    if (!rec || rec.exp < Date.now()) throw new HttpError(401, 'Invalid or expired ticket');
    const user = await this.sap.getUser(rec.userId).catch(() => null);
    if (!user || user.status !== 'active') throw new HttpError(401, 'Account is not active');
    return user;
  }
}
