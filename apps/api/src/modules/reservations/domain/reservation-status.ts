import { errors } from '@deehub/shared';

/** Reservation lifecycle (domain-model.md §3.6). */
export const RESERVATION_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
  'EXPIRED',
] as const;

export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * States that consume inventory.
 *
 * CHECKED_OUT still holds: the guest occupied those nights, and releasing them
 * afterwards would make historical occupancy reports lie.
 */
const INVENTORY_HOLDING: ReadonlySet<ReservationStatus> = new Set([
  'PENDING',
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
]);

export function holdsInventory(status: ReservationStatus): boolean {
  return INVENTORY_HOLDING.has(status);
}

/**
 * Allowed transitions. Anything absent here is rejected by the domain, not
 * merely hidden in the UI — an OTA webhook or a stale browser tab must not be
 * able to check in a cancelled reservation.
 */
const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  PENDING: ['CONFIRMED', 'CANCELLED', 'EXPIRED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  // Back-steps exist for a button pressed by mistake: undo check-in returns to
  // CONFIRMED, undo check-out returns to CHECKED_IN. Each has its own use case
  // that reverses the side effects of the forward move.
  CHECKED_IN: ['CHECKED_OUT', 'CANCELLED', 'CONFIRMED'],
  CHECKED_OUT: ['CHECKED_IN'],
  CANCELLED: [],
  NO_SHOW: [],
  EXPIRED: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws the typed INVALID_STATE_TRANSITION error when the move is illegal. */
export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!canTransition(from, to)) {
    throw errors.invalidTransition(from, to);
  }
}

export function isTerminal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
