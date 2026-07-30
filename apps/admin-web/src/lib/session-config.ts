/**
 * Cookie names and API location.
 *
 * Deliberately free of `server-only` and `next/headers`: middleware runs on the
 * Edge runtime and cannot import either, but it needs exactly these values.
 */

export const ACCESS_COOKIE = 'deehub_at';
export const REFRESH_COOKIE = 'deehub_rt';
export const EXPIRY_COOKIE = 'deehub_exp';

/**
 * The last account that signed in on this browser: organization slug, email and
 * display name. Never a password and never a token.
 *
 * It exists because the organization slug is the one field nobody can
 * remember — it is an identifier the product chose, not something staff know.
 * httpOnly even though it holds no credential: an XSS bug should not be able to
 * read a colleague's address out of the browser.
 */
export const LAST_ACCOUNT_COOKIE = 'deehub_last';

/** Long enough that a front desk never retypes it, short enough to lapse. */
export const LAST_ACCOUNT_MAX_AGE = 180 * 24 * 60 * 60;

export interface LastAccount {
  readonly organizationSlug: string;
  readonly email: string;
  readonly fullName: string;
}

export function encodeLastAccount(account: LastAccount): string {
  return Buffer.from(JSON.stringify(account), 'utf8').toString('base64url');
}

/** Returns null for anything malformed — a bad cookie must not break login. */
export function decodeLastAccount(value: string | undefined): LastAccount | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { organizationSlug, email, fullName } = parsed as Record<string, unknown>;
    if (typeof organizationSlug !== 'string' || typeof email !== 'string') return null;
    return {
      organizationSlug,
      email,
      fullName: typeof fullName === 'string' ? fullName : email,
    };
  } catch {
    return null;
  }
}

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
