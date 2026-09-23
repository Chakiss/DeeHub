import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { dateRange, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { ariSyncRequests, channels } from '../../../database/schema';
import { PushAriUseCase } from './push-ari.usecase';

/** After this many failed rounds the request is set aside and the channel flagged, rather than retried forever. */
const MAX_ATTEMPTS = 10;
/** Groups (channel × room type) handled per run: bounds a maintenance pass. */
const MAX_GROUPS = 200;

export interface DrainResult {
  readonly groups: number;
  readonly pushed: number;
  readonly failed: number;
  readonly abandoned: number;
}

/**
 * Push what the relay recorded while there was no Redis to enqueue into.
 *
 * Groups pending rows by channel and room type, unions their date spans —
 * that is the debounce the Redis set provides in the event-driven path —
 * and pushes once per group through the same `PushAriUseCase` the worker
 * uses. Absolute state, so pushing a wider span than any single change
 * asked for is harmless and pushing twice is not.
 *
 * Runs from the maintenance job (every few minutes). A failure leaves the
 * rows PENDING with the error and a bumped attempt count; after
 * `MAX_ATTEMPTS` the rows are ABANDONED and the channel carries the error,
 * so the dashboard shows a red channel rather than a queue growing quietly.
 */
@Injectable()
export class DrainAriRequestsUseCase {
  private readonly logger = new Logger(DrainAriRequestsUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly push: PushAriUseCase,
  ) {}

  async execute(now: Date = new Date()): Promise<DrainResult> {
    const groups = await this.db
      .select({
        channelId: ariSyncRequests.channelId,
        roomTypeId: ariSyncRequests.roomTypeId,
        status: channels.status,
      })
      .from(ariSyncRequests)
      .innerJoin(channels, eq(channels.id, ariSyncRequests.channelId))
      .where(eq(ariSyncRequests.status, 'PENDING'))
      .groupBy(ariSyncRequests.channelId, ariSyncRequests.roomTypeId, channels.status)
      .orderBy(asc(sql`min(${ariSyncRequests.requestedAt})`))
      .limit(MAX_GROUPS);

    const result = { groups: groups.length, pushed: 0, failed: 0, abandoned: 0 };

    for (const group of groups) {
      // Claim the rows, so two overlapping runs cannot push the same change twice.
      const claimed = await this.db.transaction(async (tx) => {
        const rows = await tx
          .select({
            id: ariSyncRequests.id,
            dateFrom: ariSyncRequests.dateFrom,
            dateTo: ariSyncRequests.dateTo,
            attempts: ariSyncRequests.attempts,
          })
          .from(ariSyncRequests)
          .where(
            and(
              eq(ariSyncRequests.channelId, group.channelId),
              eq(ariSyncRequests.roomTypeId, group.roomTypeId),
              eq(ariSyncRequests.status, 'PENDING'),
            ),
          )
          .for('update', { skipLocked: true });
        return rows;
      });
      if (claimed.length === 0) continue;

      const ids = claimed.map((row) => row.id);

      // A channel the hotel switched off owes nothing; the requests are
      // dropped, like the relay drops them up front. ERROR is not off — it is
      // a live channel whose last push failed, which is exactly what a retry
      // is for.
      if (group.status === 'INACTIVE') {
        await this.db
          .update(ariSyncRequests)
          .set({ status: 'PUSHED', pushedAt: now, lastError: 'channel not active; dropped' })
          .where(inArray(ariSyncRequests.id, ids));
        continue;
      }

      const dates = new Set<IsoDate>();
      for (const row of claimed) {
        for (const date of dateRange(toIsoDate(row.dateFrom), toIsoDate(row.dateTo)))
          dates.add(date);
        dates.add(toIsoDate(row.dateTo));
      }
      const attempt = Math.max(...claimed.map((row) => row.attempts)) + 1;

      try {
        await this.push.execute({
          channelId: group.channelId,
          roomTypeId: group.roomTypeId,
          dates: [...dates].sort(),
          attempt,
        });
        await this.db
          .update(ariSyncRequests)
          .set({ status: 'PUSHED', pushedAt: now, attempts: attempt, lastError: null })
          .where(inArray(ariSyncRequests.id, ids));
        result.pushed += 1;
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        const abandon = attempt >= MAX_ATTEMPTS;
        await this.db
          .update(ariSyncRequests)
          .set({ status: abandon ? 'ABANDONED' : 'PENDING', attempts: attempt, lastError: message })
          .where(inArray(ariSyncRequests.id, ids));
        if (abandon) {
          result.abandoned += 1;
          this.logger.error(
            `ARI push to channel ${group.channelId} abandoned after ${String(attempt)} attempts: ${message}`,
          );
        } else {
          result.failed += 1;
          this.logger.warn(
            `ARI push to channel ${group.channelId} failed (attempt ${String(attempt)}): ${message}`,
          );
        }
      }
    }

    return result;
  }
}
