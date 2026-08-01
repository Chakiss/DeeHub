import './config/load-dotenv';
import { initSentry } from './observability/sentry';

// Before every other import: Sentry instruments modules as they load, so
// anything imported earlier reports nothing.
initSentry('worker');

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { WorkerModule } from './worker.module';
import { DATABASE, type Database } from './database/database.module';
import { OutboxRelayService } from './modules/outbox/outbox-relay.service';
import { ExpireHoldsUseCase } from './modules/inventory/application/expire-holds.usecase';
import { ReconcileInventoryUseCase } from './modules/inventory/application/reconcile-inventory.usecase';
import { DispatchNotificationsUseCase } from './modules/notifications/application/dispatch-notifications.usecase';
import { PurgeResetTokensUseCase } from './modules/auth/application/purge-reset-tokens.usecase';

/**
 * One-shot maintenance pass, for deployments with no channels connected.
 *
 * The long-running worker exists to consume queues with sub-minute latency,
 * which costs an always-on Cloud Run instance. A property that is not yet
 * selling through an OTA has nothing to push, so the same housekeeping can run
 * on a schedule instead and the instance can scale to zero
 * (docs/deployment.md §8).
 *
 * Runs the outbox relay to completion, sends whatever notifications it just
 * composed, expires lapsed holds, and — the reason this must not be skipped —
 * reconciles inventory, which is the alarm for booking-path bugs.
 *
 * The relay runs BEFORE the dispatcher on purpose: composing and sending in
 * one pass means a guest waits one scheduler interval for a confirmation
 * rather than two.
 *
 * Deliberately creates NO BullMQ workers: it is a job that finishes, and a
 * queue consumer never would.
 */

/** Bounded so a runaway backlog cannot keep a job running indefinitely. */
const MAX_RELAY_PASSES = 100;
const MAX_DISPATCH_PASSES = 100;

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  const logger = new Logger('Maintenance');
  let failed = false;

  try {
    const relay = app.get(OutboxRelayService);
    let published = 0;
    for (let pass = 0; pass < MAX_RELAY_PASSES; pass += 1) {
      const count = await relay.drainOnce();
      if (count === 0) break;
      published += count;
    }
    logger.log(`Outbox: published ${String(published)} event(s)`);

    // An event that keeps failing must not report success. Without this a
    // channel activated on a deployment with no Redis would leave bookings
    // stuck forever while every scheduled run looked green.
    const stuck = await app.get<Database>(DATABASE).execute<{ count: number; sample: string }>(sql`
      SELECT COUNT(*)::int AS count, COALESCE(MIN(left(last_error, 120)), '') AS sample
        FROM outbox_events
       WHERE published_at IS NULL AND attempts > 0
    `);
    const stuckCount = Number(stuck.rows[0]?.count ?? 0);
    if (stuckCount > 0) {
      logger.error(
        `Outbox: ${String(stuckCount)} event(s) could not be published — ${String(stuck.rows[0]?.sample)}`,
      );
      failed = true;
    }

    const dispatch = app.get(DispatchNotificationsUseCase);
    let sent = 0;
    let undelivered = 0;
    for (let pass = 0; pass < MAX_DISPATCH_PASSES; pass += 1) {
      const result = await dispatch.runOnce();
      sent += result.sent;
      undelivered += result.failed;
      // Deferred rows are retried on the NEXT run, not in a tight loop here:
      // whatever refused them a second ago will refuse them again now.
      if (result.sent + result.failed + result.skipped + result.deferred === 0) break;
      if (result.deferred > 0 && result.sent === 0) break;
    }
    if (sent > 0 || undelivered > 0) {
      logger.log(`Notifications: sent ${String(sent)}, gave up on ${String(undelivered)}`);
    }
    /*
     * A message nobody received is NOT a job failure. It is usually the
     * deployment having no email provider configured, which is a decision
     * rather than a fault — and exiting non-zero for it would train whoever
     * watches this job to ignore the exit code that means inventory drift.
     */

    const purged = await app.get(PurgeResetTokensUseCase).execute();
    if (purged.removed > 0) {
      logger.log(`Password resets: forgot ${String(purged.removed)} expired token(s)`);
    }

    const holds = await app.get(ExpireHoldsUseCase).execute();
    if (holds.expired > 0) {
      logger.log(
        `Holds: expired ${String(holds.expired)}, released ${String(holds.nightsReleased)} night(s)`,
      );
    }

    const reconciliation = await app.get(ReconcileInventoryUseCase).execute();
    logger.log(`Reconciliation: checked ${String(reconciliation.checked)} night(s)`);

    if (reconciliation.drift.length > 0) {
      // Non-zero exit so the scheduler surfaces it. Drift means a bug in the
      // booking path and must be looked at the same day — it is the one thing
      // here that should page someone.
      logger.error(
        `INVENTORY DRIFT on ${String(reconciliation.drift.length)} night(s): ` +
          reconciliation.drift
            .slice(0, 5)
            .map(
              (row) =>
                `${row.roomTypeId}@${row.date} actual=${String(row.actual)} expected=${String(row.expected)}`,
            )
            .join('; '),
      );
      failed = true;
    }
  } catch (error) {
    logger.error(`Maintenance pass failed: ${String(error)}`);
    failed = true;
  } finally {
    await app.close();
  }

  process.exit(failed ? 1 : 0);
}

void main();
