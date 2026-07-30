import { Inject, Injectable } from '@nestjs/common';
import {
  dateRange,
  dayOfWeek,
  errors,
  EVENT_TYPES,
  type DayOfWeek,
  type IsoDate,
} from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { OutboxService, type OutboxEventInput } from '../../../common/outbox/outbox.service';
import {
  INVENTORY_REPOSITORY,
  type InventoryPatch,
  type InventoryRepository,
} from '../domain/inventory.repository';

export interface InventoryUpdate {
  readonly roomTypeId: string;
  /** Inclusive. */
  readonly from: IsoDate;
  /** Exclusive, matching every other range in the API. */
  readonly to: IsoDate;
  /** Restrict the edit to these weekdays. Omit for every day in the range. */
  readonly daysOfWeek?: readonly DayOfWeek[];
  readonly allotment?: number;
  readonly stopSell?: boolean;
  readonly minStay?: number;
  readonly maxStay?: number | null;
  readonly closedToArrival?: boolean;
  readonly closedToDeparture?: boolean;
}

export interface UpdateInventoryInput {
  readonly propertyId: string;
  readonly updates: readonly InventoryUpdate[];
}

export interface UpdateInventoryResult {
  readonly nightsUpdated: number;
  readonly roomTypesTouched: number;
}

/**
 * Bulk inventory edit (api-spec.md §6.3).
 *
 * Bulk because no hotelier edits ninety checkboxes one at a time: one request
 * sets allotment and restrictions across a date range, optionally filtered to
 * certain weekdays ("Fridays and Saturdays over New Year").
 *
 * The whole request is ONE transaction. A partial apply would leave the
 * calendar in a state the manager never asked for and never sees.
 */
@Injectable()
export class UpdateInventoryUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(INVENTORY_REPOSITORY) private readonly inventory: InventoryRepository,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async execute(input: UpdateInventoryInput, actor: AuditActor): Promise<UpdateInventoryResult> {
    const tenant = requireTenant();
    if (input.updates.length === 0) {
      throw errors.validation('At least one update is required');
    }

    return this.db.transaction(async (tx) => {
      let nightsUpdated = 0;
      const events: OutboxEventInput[] = [];
      const roomTypes = new Set<string>();

      for (const update of input.updates) {
        const dates = this.expand(update);
        if (dates.length === 0) continue;

        // Lock in date order, exactly as the booking path does, so a bulk edit
        // and a concurrent booking queue instead of deadlocking.
        const existing = await this.inventory.lockDates(tx, update.roomTypeId, dates);

        if (update.allotment !== undefined) {
          // Refuse to drop allotment below what is already sold. The database
          // CHECK would reject it anyway; catching it here lets us name every
          // offending date instead of surfacing a constraint violation.
          const conflicts = existing
            .filter((day) => day.booked > (update.allotment ?? 0))
            .map((day) => ({ date: day.date, booked: day.booked, requested: update.allotment }));

          if (conflicts.length > 0) {
            throw errors.allotmentBelowBooked(update.roomTypeId, conflicts);
          }
        }

        const patch: InventoryPatch = {
          ...(update.allotment === undefined ? {} : { allotment: update.allotment }),
          ...(update.stopSell === undefined ? {} : { stopSell: update.stopSell }),
          ...(update.minStay === undefined ? {} : { minStay: update.minStay }),
          ...(update.maxStay === undefined ? {} : { maxStay: update.maxStay }),
          ...(update.closedToArrival === undefined
            ? {}
            : { closedToArrival: update.closedToArrival }),
          ...(update.closedToDeparture === undefined
            ? {}
            : { closedToDeparture: update.closedToDeparture }),
        };

        if (Object.keys(patch).length === 0) {
          throw errors.validation('An update must change at least one field', {
            roomTypeId: update.roomTypeId,
          });
        }

        await this.inventory.upsertRange(
          tx,
          {
            organizationId: tenant.organizationId,
            propertyId: input.propertyId,
            roomTypeId: update.roomTypeId,
          },
          dates,
          patch,
        );

        nightsUpdated += dates.length;
        roomTypes.add(update.roomTypeId);

        events.push({
          type: EVENT_TYPES.INVENTORY_CHANGED,
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          aggregateType: 'inventory',
          aggregateId: update.roomTypeId,
          payload: {
            propertyId: input.propertyId,
            roomTypeId: update.roomTypeId,
            from: dates[0],
            to: dates[dates.length - 1],
            reason: update.allotment === undefined ? 'RESTRICTION_UPDATED' : 'ALLOTMENT_UPDATED',
          },
        });

        await this.audit.record(tx, {
          organizationId: tenant.organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'inventory.updated',
          entityType: 'inventory',
          entityId: update.roomTypeId,
          after: {
            from: dates[0],
            to: dates[dates.length - 1],
            nights: dates.length,
            ...(update.daysOfWeek ? { daysOfWeek: [...update.daysOfWeek] } : {}),
            ...patch,
          },
        });
      }

      await this.outbox.recordMany(tx, events);
      return { nightsUpdated, roomTypesTouched: roomTypes.size };
    });
  }

  /** Expand a range into the nights it touches, honouring the weekday filter. */
  private expand(update: InventoryUpdate): IsoDate[] {
    const all = dateRange(update.from, update.to);
    if (!update.daysOfWeek || update.daysOfWeek.length === 0) return all;
    const wanted = new Set(update.daysOfWeek);
    return all.filter((date) => wanted.has(dayOfWeek(date)));
  }
}
