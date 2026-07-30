import 'server-only';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from './session-config';

/**
 * Server-side session access.
 *
 * The dashboard is a BACKEND-FOR-FRONTEND: the browser never sees a DeeHub
 * access token. Login goes through this app's own route handler, which stores
 * the tokens in httpOnly cookies on the dashboard's origin; server components
 * read them and call the API. That removes CORS entirely and means an XSS bug
 * in a React component cannot exfiltrate a session (api-spec.md §3).
 */

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly organizationId: string;
  readonly memberships: readonly { role: string; propertyId: string | null }[];
  readonly capabilities: readonly string[];
}

export async function getAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

export {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  EXPIRY_COOKIE,
  cookieOptions,
  apiBaseUrl,
} from './session-config';
