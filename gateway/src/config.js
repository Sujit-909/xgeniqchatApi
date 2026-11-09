import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function secret(name) {
  const v = env[name];
  if (v) return v;
  if (isProd) throw new Error(`${name} must be set in production`);
  // Dev only: random per-process secret so nothing insecure is ever hard-coded.
  return crypto.randomBytes(32).toString('hex');
}

export function loadConfig(overrides = {}) {
  return {
    isProd,
    port: Number(env.PORT || 4000),
    corsOrigins: (env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim()),
    jwtSecret: secret('JWT_SECRET'),
    accessTtlSec: Number(env.ACCESS_TTL_SEC || 15 * 60),
    refreshTtlSec: Number(env.REFRESH_TTL_SEC || 7 * 24 * 3600),
    wsTicketTtlSec: 60,
    disconnectGraceMs: Number(env.DISCONNECT_GRACE_MS || 10_000), // a dropped socket may reconnect (Wi-Fi <-> mobile) before the call is torn down
    ringTimeoutMs: Number(env.RING_TIMEOUT_MS || 30_000),
    rateLimit: { windowMs: 60_000, max: Number(env.RATE_LIMIT_MAX || 300), authMax: Number(env.AUTH_RATE_LIMIT_MAX || 20) },
    seedDemoUsers: env.SEED_DEMO_USERS ? env.SEED_DEMO_USERS === 'true' : !isProd,
    sap: { timeoutMs: Number(env.SAP_TIMEOUT_MS || 3000), baseUrl: env.SAP_BASE_URL || '' },
    video: {
      livekitUrl: env.LIVEKIT_URL || '',
      livekitKey: env.LIVEKIT_API_KEY || '',
      livekitSecret: env.LIVEKIT_API_SECRET || '',
      tokenTtlSec: 10 * 60,
      iceServers: env.ICE_SERVERS ? JSON.parse(env.ICE_SERVERS) : [{ urls: 'stun:stun.l.google.com:19302' }],
    },
    ai: {
      anthropicKey: env.ANTHROPIC_API_KEY || '',
      model: env.AI_MODEL || 'claude-sonnet-5-5',
      dailyBudgetPerUser: Number(env.AI_DAILY_REQUESTS || 200),
      maxInputChars: 8000,
    },
    ...overrides,
  };
}
