import type { IsoDate } from '@deehub/shared';

/**
 * Queue and job contracts (architecture.md §5).
 *
 * Every consumer must be idempotent: the outbox relay guarantees at-least-once
 * delivery, so a job can and will run twice.
 */

export const QUEUE_NAMES = {
  /** Push availability, rates and restrictions to one channel. */
  ARI_SYNC: 'ari-sync',
  /** Map an inbound OTA booking into a reservation. */
  RESERVATION_DELIVERY: 'reservation-delivery',
  /** Scheduled housekeeping: hold expiry, reconciliation. */
  MAINTENANCE: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface AriSyncJob {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly channelId: string;
  readonly roomTypeId: string;
}

export interface ReservationDeliveryJob {
  readonly organizationId: string;
  readonly channelReservationId: string;
}

export const MAINTENANCE_JOBS = {
  EXPIRE_HOLDS: 'expire-holds',
  RECONCILE_INVENTORY: 'reconcile-inventory',
  PRUNE_OUTBOX: 'prune-outbox',
} as const;

export type MaintenanceJobName = (typeof MAINTENANCE_JOBS)[keyof typeof MAINTENANCE_JOBS];

/**
 * Redis key holding the dates awaiting an ARI push for one channel and room
 * type.
 *
 * Why a set rather than date ranges on the job: ten edits to the same room type
 * within the debounce window collapse into one push, and a set naturally
 * deduplicates without any range-merging logic. The job drains it and computes
 * the span to send.
 */
export function ariDirtyKey(channelId: string, roomTypeId: string): string {
  return `deehub:ari-dirty:${channelId}:${roomTypeId}`;
}

/**
 * Deterministic job id, so BullMQ collapses repeat requests while one is still
 * waiting. This is the debounce.
 */
export function ariJobId(channelId: string, roomTypeId: string): string {
  // Hyphens, not colons: BullMQ rejects ':' in a custom job id because it
  // separates its own Redis key segments.
  return `ari-${channelId}-${roomTypeId}`;
}

export function deliveryJobId(channelReservationId: string): string {
  return `delivery-${channelReservationId}`;
}

export interface AriDateSpan {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly dates: readonly IsoDate[];
}
