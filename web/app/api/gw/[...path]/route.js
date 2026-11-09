import { NextResponse } from 'next/server';
import { GATEWAY, setSession, clearSession } from '@/lib/server/session';

// Backend-for-frontend proxy: adds the bearer token from the HTTP-only cookie and transparently refreshes it once on 401.
async function handle(request, { params }) {
  const { path } = await params;
  if (!Array.isArray(path) || path.some((p) => !p || p === '.' || p === '..')) return NextResponse.json({ error: 'Bad path' }, { status: 400 });
  // Credentials are only ever exchanged by the dedicated /api/auth routes; the only auth call allowed here is the WS ticket.
  if (path[0] === 'auth' && path[1] !== 'ws-ticket') return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (request.method !== 'GET') { // CSRF defense in depth on top of SameSite=Lax cookies
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== request.headers.get('host')) return NextResponse.json({ error: 'Cross-origin request blocked' }, { status: 403 });
  }

  const target = `${GATEWAY}/v1/${path.map(encodeURIComponent).join('/')}${new URL(request.url).search}`;
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const send = (token) => fetch(target, { method: request.method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body || undefined, cache: 'no-store' });

  const at = request.cookies.get('hub_at')?.value;
  const rt = request.cookies.get('hub_rt')?.value;
  let upstream; let fresh = null;
  try {
    upstream = at ? await send(at) : new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401 });
    if (upstream.status === 401 && rt) {
      const rr = await fetch(`${GATEWAY}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }), cache: 'no-store' });
      if (rr.ok) { fresh = await rr.json(); upstream = await send(fresh.accessToken); }
    }
  } catch { return NextResponse.json({ error: 'Gateway unreachable' }, { status: 502 }); }

  const text = upstream.status === 204 ? null : await upstream.text();
  const res = new NextResponse(text, { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  if (fresh) setSession(res, fresh);
  else if (upstream.status === 401) clearSession(res);
  return res;
}

export { handle as GET, handle as POST };
