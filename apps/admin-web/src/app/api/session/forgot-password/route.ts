import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/session';

/**
 * Forgot-password proxy (the BFF half).
 *
 * Nothing is stored and no cookie is set — this handler exists only because the
 * API is not necessarily reachable from a browser, and the dashboard's own
 * origin is.
 *
 * The response is 202 with the same body no matter what the API said, including
 * when the API could not be reached at all. That is the same position the API
 * takes and for the same reason: any variation here would put back the
 * user-enumeration oracle it goes to some trouble to remove. The person is told
 * to check their mail; if nothing arrives, the fault is in the logs, not in a
 * message that would also tell an attacker which addresses are real.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  await fetch(`${apiBaseUrl()}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => null);

  return NextResponse.json({ accepted: true }, { status: 202 });
}
