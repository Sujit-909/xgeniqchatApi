import { NextResponse } from 'next/server';
import { GATEWAY, clearSession } from '@/lib/server/session';

export async function POST(request) {
  const rt = request.cookies.get('hub_rt')?.value;
  if (rt) await fetch(`${GATEWAY}/v1/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }), cache: 'no-store' }).catch(() => {});
  const res = NextResponse.json({ ok: true });
  clearSession(res);
  return res;
}
