// SAP integration layer. The gateway talks to SAP only through this client (OData/REST in production).
// MockSapBackend stands in for the ABAP services so the whole stack runs without an SAP system.
import { hashPassword, verifyPassword } from '../lib/password.js';

const DEMO_PASSWORD = 'Password@123';

export class MockSapBackend {
  constructor({ seed = true } = {}) {
    this.users = new Map(); // appUserId -> record (mirrors ZUSER_MAP + directory)
    this.calls = new Map(); // ZCALL_SESSION
    this.summaries = new Map(); // ZCALL_AI_SUMMARY
    this.failing = false; // test hook: simulate SAP outage
    this.latencyMs = 0;
    if (seed) this.#seed();
  }

  #seed() {
    const base = ['call:create', 'chat:use', 'ai:use'];
    const rows = [
      ['APP00001', 'SAP10001', 'EMP00001', 'Alice Manager', 'alice@company.com', 'manager', [...base, 'ai:approve']],
      ['APP00002', 'SAP10002', 'EMP00002', 'Bob Technician', 'bob@company.com', 'technician', base],
      ['APP00003', 'SAP10003', 'EMP00003', 'Carol Technician', 'carol@company.com', 'technician', base],
      ['APP00004', 'SAP10004', 'EMP00004', 'Dave Admin', 'dave@company.com', 'admin', [...base, 'ai:approve', 'admin:reports']],
    ];
    for (const [appUserId, sapUserId, employeeId, name, email, role, permissions] of rows) {
      this.users.set(appUserId, { appUserId, sapUserId, employeeId, videoUserId: appUserId.replace('APP', 'VIDEO'), name, email, role, permissions, status: 'active', passwordHash: hashPassword(DEMO_PASSWORD) });
    }
    this.users.set('APP00005', { appUserId: 'APP00005', sapUserId: 'SAP10005', employeeId: 'EMP00005', videoUserId: 'VIDEO00005', name: 'Erin Inactive', email: 'erin@company.com', role: 'technician', permissions: base, status: 'inactive', passwordHash: hashPassword(DEMO_PASSWORD) });
  }

  async #io() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.failing) throw new Error('SAP unavailable');
  }

  async getUser(id) { await this.#io(); return this.users.get(id) || null; }
  async listUsers() { await this.#io(); return [...this.users.values()]; }
  async findByEmail(email) {
    await this.#io();
    const e = String(email || '').trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email.toLowerCase() === e) || null;
  }
  async verifyCredentials(email, password) {
    const u = await this.findByEmail(email);
    // Always run a hash comparison so unknown emails and wrong passwords cost the same.
    const ok = verifyPassword(password, u?.passwordHash || 'scrypt$00$00');
    return u && ok ? u : null;
  }
  async saveCallSession(rec) { await this.#io(); this.calls.set(rec.callId, rec); }
  async saveSummary(rec) { await this.#io(); this.summaries.set(rec.callId + ':' + rec.approvedAt, rec); }
}

export function publicUser(u) {
  if (!u) return null;
  const { passwordHash, sapUserId, employeeId, ...rest } = u;
  return rest;
}

class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 10_000 } = {}) { this.threshold = threshold; this.cooldownMs = cooldownMs; this.failures = 0; this.openedAt = 0; }
  get open() { return this.failures >= this.threshold && Date.now() - this.openedAt < this.cooldownMs; }
  success() { this.failures = 0; }
  failure() { this.failures++; if (this.failures >= this.threshold) this.openedAt = Date.now(); }
}

export class SapClient {
  constructor(config, backend = new MockSapBackend({ seed: config.seedDemoUsers })) {
    this.backend = backend;
    this.timeoutMs = config.sap.timeoutMs;
    this.breaker = new CircuitBreaker();
    this.cache = new Map(); // appUserId -> { at, user }
    this.cacheTtlMs = 30_000;
    this.pendingWrites = []; // call records waiting for SAP to recover
    this.retryTimer = setInterval(() => this.flush().catch(() => {}), 5_000);
    this.retryTimer.unref();
  }

  async #guard(fn) {
    if (this.breaker.open) throw new Error('SAP circuit open');
    let timer;
    try {
      const res = await Promise.race([fn(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SAP timeout')), this.timeoutMs); })]);
      this.breaker.success();
      return res;
    } catch (e) { this.breaker.failure(); throw e; } finally { clearTimeout(timer); }
  }

  /** Cached identity + authorization lookup. Falls back to a stale cache entry if SAP is down. */
  async getUser(id, { fresh = false } = {}) {
    const hit = this.cache.get(id);
    if (!fresh && hit && Date.now() - hit.at < this.cacheTtlMs) return hit.user;
    try {
      const user = await this.#guard(() => this.backend.getUser(id));
      this.cache.set(id, { at: Date.now(), user });
      return user;
    } catch (e) {
      if (hit) return hit.user; // calls stay usable if SAP is briefly unavailable
      throw e;
    }
  }

  invalidate(id) { this.cache.delete(id); }
  listUsers() { return this.#guard(() => this.backend.listUsers()); }
  verifyCredentials(email, password) { return this.#guard(() => this.backend.verifyCredentials(email, password)); }

  /** Asynchronous, retried write of a finished call (never blocks the call experience). */
  recordCall(record) { this.#write(() => this.backend.saveCallSession(record), record.callId); }
  saveSummary(record) { return this.#guard(() => this.backend.saveSummary(record)); }

  #write(fn, key) {
    this.#guard(fn).catch(() => { this.pendingWrites.push({ fn, key, attempts: 1 }); });
  }

  async flush() {
    const batch = this.pendingWrites.splice(0);
    for (const w of batch) {
      try { await this.#guard(w.fn); } catch { if (++w.attempts <= 20) this.pendingWrites.push(w); }
    }
  }

  close() { clearInterval(this.retryTimer); }
}
