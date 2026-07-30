/**
 * Cookie names and API location.
 *
 * Deliberately free of `server-only` and `next/headers`: middleware runs on the
 * Edge runtime and cannot import either, but it needs exactly these values.
 */

export const ACCESS_COOKIE = 'deehub_at';
export const REFRESH_COOKIE = 'deehub_rt';
export const EXPIRY_COOKIE = 'deehub_exp';

export function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Base URL of the DeeHub API. Server-side only — never exposed to the client. */
export function apiBaseUrl(): string {
  return process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';
}
