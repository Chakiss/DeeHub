import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { EVENT_TYPES, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { reservationStayNights, reservations } from '../../../database/schema';
import { AuditService } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
import { runWithTenant } from '../../../common/tenant/tenant-context';
import { INVENTORY_REPOSITORY, type InventoryRepository } from '../domain/inventory.repository';

export interface ExpireHoldsResult {
  readonly expired: number;
  readonly nightsReleased: number;
}

const SYSTEM_ACTOR = {
  type: 'SYSTEM' as const,
  id: null,
  label: 'hold-expiry-sweeper',
};

/**
 * Releases inventory held by PENDING reservations whose hold has lapsed.
 *
 * Without this, an unfinished booking-engine checkout would hold a room
 * forever. That is not just untidy — it is an availability-denial vector: an
 * attacker could hold a hotel's entire inventory by starting bookings and never
 * paying (domain-model.md §3.5).
 *
 * Each reservation is expired in its own transaction so one problem row cannot
 * block the rest of the sweep.
 */
@Injectable()
export class ExpireHoldsUseCase {
  private readonly logger = new Logger(ExpireHoldsUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(now: Date = new Date()): Promise<ExpireHoldsResult> {
    const expiring = await this.db
      .select({
        id: reservations.id,
        organizationId: reservations.organizationId,
        propertyId: reservations.propertyId,
        code: reservations.code,
        version: reservations.version,
      })
      .from(reservations)
      .where(
        and(
          eq(reservations.status, 'PENDING'),
          isNotNull(reservations.holdExpiresAt),
          lte(reservations.holdExpiresAt, now),
        ),
      )
      .limit(500);

    let expired = 0;
    let nightsReleased = 0;

    for (const reservation of expiring) {
      try {
        nightsReleased += await this.expireOne(reservation, now);
        expired += 1;
      } catch (error) {
        this.logger.error(
          `Failed to expire hold ${reservation.code} (${reservation.id}): ${String(error)}`,
        );
      }
    }

    if (expired > 0) {
      this.logger.log(
        `Expired ${String(expired)} holds, released ${String(nightsReleased)} nights`,
      );
    }
    return { expired, nightsReleased };
  }

  private async expireOne(
    reservation: {
      id: string;
      organizationId: string;
      propertyId: string;
      code: string;
      version: number;
    },
    now: Date,
  ): Promise<number> {
    // The sweeper runs outside any request, so it establishes its own tenant
    // scope — repositories refuse to run without one.
    return runWithTenant(
      {
        organizationId: reservation.organizationId,
        userId: null,
        propertyId: reservation.propertyId,
        requestId: `hold-expiry-${reservation.id}`,
      },
      () =>
        this.db.transaction(async (tx) => {
          // Re-read under the version guard: a guest may have completed payment
          // between the scan and now, and confirming a paid booking must win
          // over expiring it.
          const updated = await tx
            .update(reservations)
            .set({ status: 'EXPIRED', version: reservation.version + 1, updatedAt: now })
            .where(
              and(
                eq(reservations.id, reservation.id),
                eq(reservations.status, 'PENDING'),
                eq(reservations.version, reservation.version),
              ),
            );

          if ((updated.rowCount ?? 0) !== 1) {
            this.logger.debug(`Hold ${reservation.code} changed before expiry; skipping`);
            return 0;
          }

          const nights = await tx
            .select({
              roomTypeId: reservationStayNights.roomTypeId,
              date: reservationStayNights.date,
            })
            .from(reservationStayNights)
            .where(eq(reservationStayNights.reservationId, reservation.id));

          const byRoomType = new Map<string, IsoDate[]>();
          for (const night of nights) {
            const list = byRoomType.get(night.roomTypeId) ?? [];
            list.push(toIsoDate(night.date));
            byRoomType.set(night.roomTypeId, list);
          }

          const events: OutboxEventInput[] = [];
          let released = 0;

          for (const [roomTypeId, dates] of byRoomType) {
            const ordered = [...dates].sort();
            await this.inventory.lockDates(tx, roomTypeId, ordered);
            const count = await this.inventory.release(tx, roomTypeId, ordered, 1);
            if (count !== ordered.length) {
              throw new Error(
                `Release mismatch for room type ${roomTypeId}: expected ${String(ordered.length)}, released ${String(count)}`,
              );
            }
            released += count;

            events.push({
              type: EVENT_TYPES.INVENTORY_CHANGED,
              organizationId: reservation.organizationId,
              propertyId: reservation.propertyId,
              aggregateType: 'inventory',
              aggregateId: roomTypeId,
              payload: {
                propertyId: reservation.propertyId,
                roomTypeId,
                from: ordered[0],
                to: ordered[ordered.length - 1],
                reason: 'BOOKED_CHANGED',
              },
            });
          }

          await this.audit.record(tx, {
            organizationId: reservation.organizationId,
            propertyId: reservation.propertyId,
            actor: SYSTEM_ACTOR,
            action: 'reservation.hold_expired',
            entityType: 'reservation',
            entityId: reservation.id,
            before: { status: 'PENDING' },
            after: { status: 'EXPIRED', nightsReleased: released },
            reason: 'Hold expired without confirmation',
          });

          events.push({
            type: EVENT_TYPES.RESERVATION_STATUS_CHANGED,
            organizationId: reservation.organizationId,
            propertyId: reservation.propertyId,
            aggregateType: 'reservation',
            aggregateId: reservation.id,
            payload: {
              reservationId: reservation.id,
              propertyId: reservation.propertyId,
              code: reservation.code,
              status: 'EXPIRED',
              channelId: null,
              affectedDates: [...byRoomType.values()].flat(),
            },
          });

          await this.outbox.recordMany(tx, events);
          return released;
        }),
    );
  }
}
