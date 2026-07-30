import type { Executor } from '../../../database/executor';

export interface GuestRecord {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly nationality: string | null;
  readonly notes: string | null;
}

export interface GuestSummary extends GuestRecord {
  readonly stays: number;
  readonly lastStay: string | null;
  readonly revenueMinor: number;
  /** Other profiles sharing this email — the merge queue, not a merge. */
  readonly possibleDuplicates: number;
}

export interface CreateGuestRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly firstName: string;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Guest profiles (roadmap Phase 4).
 *
 * The table has existed since the first migration and nothing ever wrote to
 * it: bookings kept a booker name on the reservation and `guestId` stayed
 * null, so no history ever accrued.
 */
export interface GuestRepository {
  /**
   * An existing profile for this person, matched on email AND last name.
   *
   * Email alone would be the obvious rule and is the wrong one. Shared
   * addresses are real — a company books its staff through `info@`, a family
   * uses one inbox — and matching on it alone silently shows one guest another
   * guest's stay history. A duplicate profile is the safer failure: it is
   * visible, and it can be merged. A wrong merge is invisible and cannot be
   * undone from the data.
   */
  findMatch(
    tx: Executor,
    email: string | null,
    lastName: string | null,
  ): Promise<GuestRecord | null>;

  insert(tx: Executor, record: CreateGuestRecord): Promise<void>;
  findById(tx: Executor, guestId: string): Promise<GuestSummary | null>;

  /**
   * Free-text over name, email and phone, limited to guests who have booked at
   * this property.
   *
   * The profile itself is organization-wide — the same person across a group is
   * the point of keeping one — but the LIST is per property, for two reasons.
   * It is what a front desk means by "our guests", and it is what makes the
   * screen reachable at all: administering people organization-wide is a
   * permission most hotel staff do not have, and refusing a receptionist the
   * guest list would be absurd.
   *
   * The stay counts stay organization-wide. Someone who stayed twice at the
   * sister hotel is a returning guest, and hiding that would waste the profile.
   */
  search(
    tx: Executor,
    propertyId: string,
    term: string | null,
    limit: number,
  ): Promise<readonly GuestSummary[]>;
  update(
    tx: Executor,
    guestId: string,
    fields: Partial<Pick<GuestRecord, 'firstName' | 'lastName' | 'email' | 'phone' | 'notes'>>,
  ): Promise<void>;
}

export const GUEST_REPOSITORY = Symbol('GUEST_REPOSITORY');

/**
 * Split a single supplied name into first and last.
 *
 * Bookings capture one `name` field, and OTAs deliver whatever the guest
 * typed. The last whitespace-separated token is treated as the family name,
 * which is right for "Somchai Prasert" and for most Latin-script names, and
 * wrong for some — so it is only ever a starting point a human can correct on
 * the profile, never something the system re-derives later.
 */
export function splitName(name: string): { firstName: string; lastName: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: name.trim() || 'Guest', lastName: null };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: null };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
}
