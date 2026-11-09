import { NextResponse } from 'next/server';
import { GATEWAY, setSession } from '@/lib/server/session';

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  let r;
  try {
    r = await fetch(`${GATEWAY}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: body.email, password: body.password }), cache: 'no-store' });
  } catch { return NextResponse.json({ error: 'Cannot reach the gateway. Is it running?' }, { status: 502 }); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return NextResponse.json({ error: data.error || 'Login failed' }, { status: r.status });
  const res = NextResponse.json({ user: data.user });
  setSession(res, data);
  return res;
}
