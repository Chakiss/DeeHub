import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, EXPIRY_COOKIE, REFRESH_COOKIE, apiBaseUrl } from '@/lib/session';
import { cookies } from 'next/headers';

export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const refreshToken = store.get(REFRESH_COOKIE)?.value;

  // Revoke server-side too, so clearing local cookies cannot leave a live
  // refresh token behind.
  if (refreshToken) {
    await fetch(`${apiBaseUrl()}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ ok: true });
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, EXPIRY_COOKIE]) {
    response.cookies.delete(name);
  }
  return response;
}
