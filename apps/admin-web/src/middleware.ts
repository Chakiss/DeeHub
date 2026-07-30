import { NextResponse, type NextRequest } from 'next/server';
import {
  ACCESS_COOKIE,
  EXPIRY_COOKIE,
  REFRESH_COOKIE,
  apiBaseUrl,
  cookieOptions,
} from '@/lib/session-config';

/** Refresh this far before expiry so a request never races the deadline. */
const REFRESH_MARGIN_MS = 60_000;

const PUBLIC_PATHS = ['/login', '/api/session'];

/**
 * Route guard and silent token refresh.
 *
 * Refresh happens HERE rather than in a server component because only
 * middleware, route handlers and server actions may write cookies in Next.js —
 * a component that refreshed would obtain a new token and then have nowhere to
 * put it.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  const expiresAt = Number(request.cookies.get(EXPIRY_COOKIE)?.value ?? '0');

  if (!accessToken && !refreshToken) {
    return redirectToLogin(request);
  }

  const needsRefresh = !accessToken || Date.now() > expiresAt - REFRESH_MARGIN_MS;
  if (!needsRefresh) return NextResponse.next();
  if (!refreshToken) return redirectToLogin(request);

  const upstream = await fetch(`${apiBaseUrl()}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream?.ok) {
    // Includes the reuse-detection case, where the API has revoked every token
    // for this user. Sending them to login is the correct outcome.
    const response = redirectToLogin(request);
    for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, EXPIRY_COOKIE]) {
      response.cookies.delete(name);
    }
    return response;
  }

  const payload = (await upstream.json().catch(() => ({}))) as {
    accessToken?: string;
    expiresIn?: number;
  };
  if (!payload.accessToken) return redirectToLogin(request);

  const response = NextResponse.next();
  const expiresIn = payload.expiresIn ?? 900;
  response.cookies.set(ACCESS_COOKIE, payload.accessToken, cookieOptions(expiresIn));
  response.cookies.set(
    EXPIRY_COOKIE,
    String(Date.now() + expiresIn * 1000),
    cookieOptions(expiresIn),
  );

  // Refresh tokens ROTATE (api-spec.md §3): keeping the old one would trip the
  // API's reuse detection on the next refresh and kill every session.
  const rotated = upstream.headers.get('set-cookie')?.match(/deehub_refresh=([^;]+)/)?.[1];
  if (rotated) {
    response.cookies.set(REFRESH_COOKIE, rotated, cookieOptions(30 * 24 * 60 * 60));
  }

  return response;
}

function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathnameIsWorthReturningTo(request.nextUrl.pathname)
    ? `?next=${encodeURIComponent(request.nextUrl.pathname)}`
    : '';
  return NextResponse.redirect(url);
}

function pathnameIsWorthReturningTo(pathname: string): boolean {
  return pathname !== '/' && !pathname.startsWith('/api');
}

export const config = {
  // Everything except static assets, so a stale token cannot slip through on a
  // page that happens not to be listed.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
