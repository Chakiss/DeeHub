import { NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/session';

interface ResetResponse {
  organizationSlug?: string;
  email?: string;
  error?: { code?: string; message?: string };
}

/**
 * Reset-password proxy (the BFF half).
 *
 * Unlike forgot-password, this one DOES pass the API's answer through: the
 * caller is holding a token that either works or does not, and telling them
 * which reveals nothing they could not learn by trying.
 *
 * No cookie is set on success. The API deliberately issues no session for a
 * link that arrived by email, so there is nothing to store — the person signs
 * in with the password they have just chosen.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const upstream = await fetch(`${apiBaseUrl()}/auth/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Could not reach the server' } },
      { status: 502 },
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as ResetResponse;

  if (!upstream.ok) {
    return NextResponse.json(
      {
        error: payload.error ?? {
          code: 'INTERNAL_ERROR',
          message: 'Could not set the password',
        },
      },
      { status: upstream.status },
    );
  }

  return NextResponse.json({
    organizationSlug: payload.organizationSlug ?? '',
    email: payload.email ?? '',
  });
}
