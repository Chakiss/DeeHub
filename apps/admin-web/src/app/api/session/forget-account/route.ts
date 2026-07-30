import { NextResponse } from 'next/server';
import { LAST_ACCOUNT_COOKIE } from '@/lib/session';

/**
 * Forget the remembered account.
 *
 * A separate action from signing out, deliberately. Signing out ends a session
 * and SHOULD leave the suggestion behind — that is the whole point of coming
 * back to a filled-in card. Forgetting is what someone does on a shared
 * front-desk machine when the address on screen is no longer theirs, and it has
 * to be reachable without signing in first.
 */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(LAST_ACCOUNT_COOKIE);
  return response;
}
