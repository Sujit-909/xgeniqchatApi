import { NextResponse } from 'next/server';

// Page guard only (the gateway still validates every call). The proxy clears cookies when the session is truly dead.
export function middleware(request) {
  const { pathname } = request.nextUrl;
  if (pathname === '/login') return NextResponse.next();
  const hasSession = request.cookies.get('hub_at') || request.cookies.get('hub_rt');
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'] };
