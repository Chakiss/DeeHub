import { NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  EXPIRY_COOKIE,
  REFRESH_COOKIE,
  apiBaseUrl,
  cookieOptions,
  getAccessToken,
} from '@/lib/session';

interface ChangePasswordResponse {
  accessToken?: string;
  expiresIn?: number;
  error?: { code?: string; message?: string };
}

/**
 * Change-password proxy (the BFF half).
 *
 * Rewriting the cookies afterwards is mandatory, not housekeeping. The API
 * revokes every session for the user as part of the change — including the one
 * making the request — so without storing the replacement pair the user would
 * be signed out by the act of securing their account.
 *
 * The passwords pass through this handler in memory and are never logged, never
 * stored, and never placed in a URL.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not signed in' } },
      { status: 401 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const upstream = await fetch(`${apiBaseUrl()}/auth/change-password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });

  const payload = (await upstream.json().catch(() => ({}))) as ChangePasswordResponse;

  if (!upstream.ok || !payload.accessToken) {
    return NextResponse.json(
      {
        error: payload.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'Could not change the password',
        },
      },
      { status: upstream.ok ? 500 : upstream.status },
    );
  }

  const response = NextResponse.json({ ok: true });
  const expiresIn = payload.expiresIn ?? 900;

  response.cookies.set(ACCESS_COOKIE, payload.accessToken, cookieOptions(expiresIn));
  response.cookies.set(
    EXPIRY_COOKIE,
    String(Date.now() + expiresIn * 1000),
    cookieOptions(expiresIn),
  );

  // As in the login handler: the API sets its refresh cookie for its own
  // origin, which this app cannot read back, so it is forwarded into ours.
  const setCookie = upstream.headers.get('set-cookie');
  const refreshToken = setCookie?.match(/deehub_refresh=([^;]+)/)?.[1];
  if (refreshToken) {
    response.cookies.set(REFRESH_COOKIE, refreshToken, cookieOptions(30 * 24 * 60 * 60));
  }

  return response;
}
