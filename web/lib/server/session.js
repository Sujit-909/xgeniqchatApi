// Server-only helpers: the Next.js server holds the gateway tokens in HTTP-only cookies (never in localStorage).
export const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:4000';
const secure = process.env.NODE_ENV === 'production';
const base = { httpOnly: true, secure, sameSite: 'lax', path: '/' };

export function setSession(res, { accessToken, refreshToken, expiresIn }) {
  res.cookies.set('hub_at', accessToken, { ...base, maxAge: Math.max(60, (expiresIn || 900) - 10) });
  res.cookies.set('hub_rt', refreshToken, { ...base, maxAge: 7 * 24 * 3600 });
}

export function clearSession(res) {
  res.cookies.set('hub_at', '', { ...base, maxAge: 0 });
  res.cookies.set('hub_rt', '', { ...base, maxAge: 0 });
}
