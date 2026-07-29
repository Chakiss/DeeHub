import { Injectable } from '@nestjs/common';
import type { DomainEventEnvelope, EventType } from '@deehub/shared';
import { newId } from '../ids';
import { outboxEvents } from '../../database/schema';
import type { Executor } from '../../database/executor';

export interface OutboxEventInput {
  readonly type: EventType;
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Transactional outbox writer (architecture.md §5).
 *
 * Every method REQUIRES an executor, and callers are expected to pass the open
 * transaction. There is deliberately no "publish now" path: enqueueing to
 * BullMQ directly from a service would let a crash between commit and enqueue
 * leave OTAs permanently stale — a silent overbooking risk — and an enqueue
 * before a rollback would push phantom availability to every channel.
 */
@Injectable()
export class OutboxService {
  async record(tx: Executor, event: OutboxEventInput): Promise<string> {
    const id = newId();
    await tx.insert(outboxEvents).values({
      id,
      organizationId: event.organizationId,
      propertyId: event.propertyId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.type,
      payload: event.payload,
    });
    return id;
  }

  async recordMany(tx: Executor, events: readonly OutboxEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await tx.insert(outboxEvents).values(
      events.map((event) => ({
        id: newId(),
        organizationId: event.organizationId,
        propertyId: event.propertyId,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.type,
        payload: event.payload,
      })),
    );
  }
}

export type { DomainEventEnvelope };
