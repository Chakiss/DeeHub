/**
 * Domain event contracts (domain-model.md §4).
 *
 * Events are written to the outbox in the same transaction as the state
 * change that produced them, then relayed to BullMQ. Consumers must be
 * idempotent: delivery is at-least-once.
 */

export const EVENT_TYPES = {
  RESERVATION_CREATED: 'reservation.created',
  RESERVATION_MODIFIED: 'reservation.modified',
  RESERVATION_CANCELLED: 'reservation.cancelled',
  RESERVATION_STATUS_CHANGED: 'reservation.status_changed',
  INVENTORY_CHANGED: 'inventory.changed',
  RATE_CHANGED: 'rate.changed',
  CHANNEL_RESERVATION_RECEIVED: 'channel.reservation_received',
  CHANNEL_SYNC_FAILED: 'channel.sync_failed',
  CHANNEL_OVERBOOKING_DETECTED: 'channel.overbooking_detected',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface DomainEventEnvelope<TPayload = unknown> {
  readonly id: string;
  readonly type: EventType;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** UTC instant the change happened, not when it was relayed. */
  readonly occurredAt: string;
  readonly actor: EventActor;
  readonly payload: TPayload;
}

export interface EventActor {
  readonly type: 'USER' | 'SYSTEM' | 'CHANNEL';
  readonly id: string | null;
  readonly label: string;
}

export interface InventoryChangedPayload {
  readonly propertyId: string;
  readonly roomTypeId: string;
  /** Inclusive. */
  readonly from: string;
  /** Exclusive. */
  readonly to: string;
  readonly reason: 'ALLOTMENT_UPDATED' | 'RESTRICTION_UPDATED' | 'BOOKED_CHANGED';
}

export interface RateChangedPayload {
  readonly propertyId: string;
  readonly ratePlanId: string;
  readonly from: string;
  readonly to: string;
}

export interface ReservationEventPayload {
  readonly reservationId: string;
  readonly propertyId: string;
  readonly code: string;
  readonly status: string;
  readonly channelId: string | null;
  readonly affectedDates: readonly string[];
}
