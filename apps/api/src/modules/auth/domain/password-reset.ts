import { createHash, randomBytes } from 'node:crypto';
import type { Executor } from '../../../database/executor';

/**
 * How long a link works. One hour.
 *
 * Short enough that a link sitting in a mailbox someone else later reads is
 * usually already dead; long enough for the realistic case, which is a
 * receptionist who requests a reset, gets pulled onto the desk, and comes back
 * to it after the morning rush.
 */
export const RESET_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How many live links one account may hold, and over what window.
 *
 * This is not brute-force protection — the token is 256 bits, guessing is not
 * the threat. It is mailbox protection: without it, anyone who knows an address
 * can use this endpoint to send that person unlimited mail from the hotel's
 * verified sender, which is both harassment and a fast way to get the domain's
 * sending reputation destroyed.
 */
export const RESET_REQUEST_LIMIT = 3;
export const RESET_REQUEST_WINDOW_SECONDS = 15 * 60;

/**
 * The raw token, and the only form of it that is stored.
 *
 * 32 bytes rather than the 48 refresh tokens use: this one has to survive being
 * pasted out of an email client that may wrap or linkify it, and 43 base64url
 * characters is already far past guessable.
 */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashResetToken(token) };
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The link a person clicks.
 *
 * The token travels in the query string, which means it lands in the browser's
 * history and in any Referer the reset page leaks. Both are accepted: the token
 * is single-use and dies within the hour, and the alternative — a form that
 * asks someone to copy a 43-character string out of an email — is the kind of
 * flow people give up on and phone the hotel about instead.
 */
export function resetLink(baseUrl: string, token: string): string {
  const url = new URL('/reset-password', baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export interface StoredResetToken {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
}

export type ResetTokenState = 'VALID' | 'UNKNOWN' | 'EXPIRED' | 'SPENT';

/**
 * Why a token cannot be used, told apart for the log and for the person.
 *
 * The person is told the same thing for every failure — "this link is no longer
 * valid, ask for another" — because the differences are not actionable to them
 * and an unauthenticated caller learning that a token EXISTED but expired is a
 * small oracle for no benefit. The distinction exists for the audit trail.
 */
export function classifyResetToken(
  stored: StoredResetToken | null,
  now: Date,
): { state: ResetTokenState } {
  if (!stored) return { state: 'UNKNOWN' };
  if (stored.consumedAt || stored.invalidatedAt) return { state: 'SPENT' };
  if (stored.expiresAt.getTime() <= now.getTime()) return { state: 'EXPIRED' };
  return { state: 'VALID' };
}

export interface PasswordResetRepository {
  insertToken(
    tx: Executor,
    token: {
      id: string;
      organizationId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      requestedIp: string | null;
    },
  ): Promise<void>;

  findByHash(tx: Executor, tokenHash: string): Promise<StoredResetToken | null>;

  /** Spend one token. Returns false if something else spent it first. */
  consume(tx: Executor, tokenId: string, at: Date): Promise<boolean>;

  /**
   * Kill every other live token for a user. Called after a successful reset and
   * after a password change: a second link still working would let whoever
   * triggered the first request in afterwards.
   */
  invalidateLiveForUser(tx: Executor, userId: string, at: Date, exceptId?: string): Promise<number>;

  /** Live tokens issued to this user inside the window, for the throttle. */
  countRecentRequests(tx: Executor, userId: string, since: Date): Promise<number>;

  /** Housekeeping: forget tokens too old to be evidence. */
  deleteOlderThan(tx: Executor, cutoff: Date): Promise<number>;
}

export const PASSWORD_RESET_REPOSITORY = Symbol('PASSWORD_RESET_REPOSITORY');
