import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  EXPIRY_COOKIE,
  LAST_ACCOUNT_COOKIE,
  LAST_ACCOUNT_MAX_AGE,
  REFRESH_COOKIE,
  apiBaseUrl,
  cookieOptions,
  encodeLastAccount,
} from '@/lib/session';

interface LoginResponse {
  accessToken?: string;
  expiresIn?: number;
  user?: { email?: string; fullName?: string };
  error?: { code?: string; message?: string };
}

/**
 * Login proxy (the BFF half of the auth flow).
 *
 * The browser posts here; this handler talks to the API and stores the tokens
 * in httpOnly cookies on the DASHBOARD's origin. The access token never reaches
 * client JavaScript, so an XSS bug cannot steal a session.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const upstream = await fetch(`${apiBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const payload = (await upstream.json().catch(() => ({}))) as LoginResponse;

  if (!upstream.ok || !payload.accessToken) {
    return NextResponse.json(
      { error: payload.error ?? { code: 'UNAUTHENTICATED', message: 'Login failed' } },
      { status: upstream.status === 200 ? 401 : upstream.status },
    );
  }

  const response = NextResponse.json({ user: payload.user });
  const expiresIn = payload.expiresIn ?? 900;

  response.cookies.set(ACCESS_COOKIE, payload.accessToken, cookieOptions(expiresIn));
  response.cookies.set(
    EXPIRY_COOKIE,
    String(Date.now() + expiresIn * 1000),
    cookieOptions(expiresIn),
  );

  // Remembered only after a SUCCESSFUL sign-in, so a typo never becomes the
  // suggestion on the next visit. Holds the organization slug, the email and
  // the display name — never the password.
  const organizationSlug =
    typeof body['organizationSlug'] === 'string' ? body['organizationSlug'] : null;
  if (organizationSlug && payload.user?.email) {
    response.cookies.set(
      LAST_ACCOUNT_COOKIE,
      encodeLastAccount({
        organizationSlug,
        email: payload.user.email,
        fullName: payload.user.fullName ?? payload.user.email,
      }),
      cookieOptions(LAST_ACCOUNT_MAX_AGE),
    );
  }

  // The API returns its refresh token in a Set-Cookie for its own origin, which
  // this app cannot use. Forward it into our own cookie so middleware can
  // refresh without the browser ever holding it.
  const setCookie = upstream.headers.get('set-cookie');
  const refreshToken = setCookie?.match(/deehub_refresh=([^;]+)/)?.[1];
  if (refreshToken) {
    response.cookies.set(REFRESH_COOKIE, refreshToken, cookieOptions(30 * 24 * 60 * 60));
  }

  return response;
}
