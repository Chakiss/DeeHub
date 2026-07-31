import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DATABASE, type Database } from '../../../database/database.module';
import { notifications } from '../../../database/schema';
import { NOTIFICATION_SENDERS, type NotificationSender } from '../domain/notification-sender';
import type { NotificationChannel } from '../domain/notification';

const BATCH_SIZE = 50;

/**
 * Attempts before a message is given up on.
 *
 * Five, not infinity: a confirmation that finally arrives three days after
 * check-out is worse than one that visibly failed, and a row retried forever
 * is a row nobody ever looks at.
 */
const MAX_ATTEMPTS = 5;

export interface DispatchResult {
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** Rows that will be tried again on a later pass. */
  readonly deferred: number;
}

/**
 * Send what is pending, one batch at a time.
 *
 * The claim and the send are deliberately NOT in one transaction. Holding a
 * row lock across an HTTP call to a mail provider would put a slow third party
 * inside a database transaction — the shape of outage that takes a booking
 * system down with it. So each row is claimed in its own short transaction,
 * sent outside any, and its outcome written back.
 *
 * That ordering makes delivery AT-LEAST-ONCE in the worst case: a crash after
 * the provider accepted a message but before the outcome was written sends it
 * twice. A duplicate confirmation is a much smaller harm than a lost one, and
 * the alternative — marking sent before sending — loses messages silently.
 */
@Injectable()
export class DispatchNotificationsUseCase {
  private readonly logger = new Logger(DispatchNotificationsUseCase.name);
  private readonly byChannel: Map<NotificationChannel, NotificationSender>;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NOTIFICATION_SENDERS) senders: readonly NotificationSender[],
  ) {
    this.byChannel = new Map(senders.map((sender) => [sender.channel, sender]));
  }

  /** Returns what happened to this batch; all zeroes when nothing was pending. */
  async runOnce(): Promise<DispatchResult> {
    const claimed = await this.claim();
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let deferred = 0;

    for (const row of claimed) {
      const sender = this.byChannel.get(row.channel as NotificationChannel);
      if (!sender) {
        // A channel in the database with no adapter compiled in. Not
        // retryable: the next pass has the same code.
        await this.finish(row.id, {
          status: 'FAILED',
          lastError: `No sender for channel ${row.channel}`,
        });
        failed += 1;
        continue;
      }

      const outcome = await sender.send({
        recipient: row.recipient,
        subject: row.subject,
        body: row.body,
      });

      if (outcome.status === 'SENT') {
        await this.finish(row.id, { status: 'SENT', sentAt: new Date() });
        sent += 1;
        continue;
      }

      if (outcome.status === 'SKIPPED') {
        await this.finish(row.id, { status: 'SKIPPED', skippedReason: outcome.reason });
        skipped += 1;
        continue;
      }

      const exhausted = !outcome.retryable || row.attempts + 1 >= MAX_ATTEMPTS;
      await this.finish(row.id, {
        status: exhausted ? 'FAILED' : 'PENDING',
        lastError: outcome.error,
      });
      if (exhausted) {
        this.logger.error(
          `Notification ${row.id} gave up after ${String(row.attempts + 1)}: ${outcome.error}`,
        );
        failed += 1;
      } else {
        deferred += 1;
      }
    }

    return { sent, failed, skipped, deferred };
  }

  /**
   * Take a batch and count the attempt in the same statement.
   *
   * `SKIP LOCKED` so two workers take disjoint slices rather than blocking,
   * and the attempt counter is incremented at CLAIM time rather than after the
   * send: a process that dies mid-send must not leave a row that can be
   * claimed forever without its counter ever moving.
   */
  private async claim() {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: notifications.id,
          channel: notifications.channel,
          recipient: notifications.recipient,
          subject: notifications.subject,
          body: notifications.body,
          attempts: notifications.attempts,
        })
        .from(notifications)
        .where(and(eq(notifications.status, 'PENDING'), lt(notifications.attempts, MAX_ATTEMPTS)))
        .orderBy(notifications.createdAt)
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });

      for (const row of rows) {
        await tx
          .update(notifications)
          .set({ attempts: sql`${notifications.attempts} + 1` })
          .where(eq(notifications.id, row.id));
      }

      return rows;
    });
  }

  private async finish(
    id: string,
    patch: {
      status: string;
      sentAt?: Date;
      lastError?: string;
      skippedReason?: string;
    },
  ): Promise<void> {
    await this.db
      .update(notifications)
      .set({
        status: patch.status,
        ...(patch.sentAt ? { sentAt: patch.sentAt } : {}),
        ...(patch.lastError ? { lastError: patch.lastError.slice(0, 1_000) } : {}),
        ...(patch.skippedReason ? { skippedReason: patch.skippedReason } : {}),
      })
      .where(eq(notifications.id, id));
  }
}
