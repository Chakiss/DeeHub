import type { IsoDate } from '@deehub/shared';

/**
 * What the system tells people, and to whom (domain-model.md §3.9).
 *
 * Deliberately three kinds and not thirty. Every message that is not worth
 * reading trains staff and guests to ignore the ones that are — the same
 * reasoning that kept the alert policies to three.
 */
export const NOTIFICATION_KINDS = [
  /** To the guest, when a booking becomes theirs to rely on. */
  'BOOKING_CONFIRMED',
  /** To the guest, when it stops being. */
  'BOOKING_CANCELLED',
  /** To the desk, when an OTA sold a room while nobody was looking. */
  'BOOKING_RECEIVED',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_CHANNELS = ['EMAIL', 'LINE'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_AUDIENCES = ['GUEST', 'STAFF'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Everything a template needs, read once when the message is composed. */
export interface BookingSummary {
  readonly reservationId: string;
  readonly code: string;
  readonly propertyName: string;
  readonly propertyPhone: string | null;
  readonly checkInTime: string;
  readonly checkOutTime: string;
  readonly bookerName: string;
  readonly checkIn: IsoDate;
  readonly checkOut: IsoDate;
  readonly nights: number;
  readonly rooms: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly channelName: string | null;
  readonly cancellationReason: string | null;
}

/** A message composed and ready to store. */
export interface ComposedNotification {
  readonly kind: NotificationKind;
  readonly channel: NotificationChannel;
  readonly audience: NotificationAudience;
  readonly recipient: string;
  readonly locale: string;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * One message per thing that happened.
 *
 * The outbox relay is at-least-once by construction, so the same reservation
 * event can be seen twice. The key is derived from what happened rather than
 * from the attempt, which is what makes the second pass a no-op instead of a
 * second confirmation in the guest's inbox.
 */
export function dedupeKey(
  kind: NotificationKind,
  reservationId: string,
  channel: NotificationChannel,
): string {
  return `${kind}:${reservationId}:${channel}`;
}
