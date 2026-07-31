import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { notifications } from '../../../database/schema';

export interface NotificationFilter {
  readonly propertyId: string;
  readonly status?: string;
  readonly kind?: string;
  readonly reservationId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NotificationEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly kind: string;
  readonly channel: string;
  readonly audience: string;
  readonly recipient: string;
  readonly locale: string;
  readonly subject: string | null;
  readonly body: string;
  readonly status: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly skippedReason: string | null;
  readonly reservationId: string | null;
  readonly context: unknown;
}

export interface NotificationPage {
  readonly items: readonly NotificationEntry[];
  /** Counts across the whole property, not just this page. */
  readonly summary: Record<string, number>;
  readonly pageInfo: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * What the hotel has told people, and what it failed to tell them.
 *
 * The failures are the reason this endpoint exists. Delivery depends on a
 * third party and on configuration nobody at the hotel controls day to day; a
 * confirmation that silently never arrived is indistinguishable from one that
 * did unless there is somewhere to look. The summary counts come with every
 * page so the screen can lead with "3 failed" rather than making someone
 * scroll to find out.
 *
 * Keyset pagination on (createdAt, id), matching the audit and reservation
 * lists.
 */
@Injectable()
export class ListNotificationsQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(filter: NotificationFilter): Promise<NotificationPage> {
    const organizationId = requireOrganizationId();
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const scope = [
      eq(notifications.organizationId, organizationId),
      eq(notifications.propertyId, filter.propertyId),
    ];

    const conditions = [...scope];
    if (filter.status) conditions.push(eq(notifications.status, filter.status));
    if (filter.kind) conditions.push(eq(notifications.kind, filter.kind));
    if (filter.reservationId) {
      conditions.push(eq(notifications.reservationId, filter.reservationId));
    }

    if (filter.cursor) {
      const after = decodeCursor(filter.cursor);
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${after.createdAt}, ${after.id})`,
      );
    }

    // One extra row to learn whether another page exists, without counting.
    const rows = await this.db
      .select({
        id: notifications.id,
        createdAt: notifications.createdAt,
        sentAt: notifications.sentAt,
        kind: notifications.kind,
        channel: notifications.channel,
        audience: notifications.audience,
        recipient: notifications.recipient,
        locale: notifications.locale,
        subject: notifications.subject,
        body: notifications.body,
        status: notifications.status,
        attempts: notifications.attempts,
        lastError: notifications.lastError,
        skippedReason: notifications.skippedReason,
        reservationId: notifications.reservationId,
        context: notifications.context,
      })
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    const counts = await this.db
      .select({ status: notifications.status, count: sql<number>`COUNT(*)::int` })
      .from(notifications)
      .where(and(...scope))
      .groupBy(notifications.status);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        sentAt: row.sentAt ? row.sentAt.toISOString() : null,
      })),
      summary: Object.fromEntries(counts.map((row) => [row.status, row.count])),
      pageInfo: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
      },
    };
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

/** A malformed cursor is a client error, never a 500. */
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('malformed');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw errors.validation('Invalid cursor');
  }
}
