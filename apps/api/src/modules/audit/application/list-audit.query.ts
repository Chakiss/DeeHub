import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import { auditLogs } from '../../../database/schema';

export interface AuditFilter {
  readonly propertyId: string;
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly actorType: string;
  readonly actorLabel: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly reason: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
}

export interface AuditPage {
  readonly items: readonly AuditEntry[];
  readonly pageInfo: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The audit trail (roadmap Phase 2).
 *
 * Every write in this system has been recorded since the first migration and
 * nothing could read it back — the `audit:read` capability existed with no
 * endpoint behind it. An audit trail nobody can open is a liability rather
 * than a control: it costs storage on every write and answers nothing.
 *
 * Keyset pagination on (createdAt, id), matching the reservation list. An
 * OFFSET would skip or repeat rows as new entries land, and entries land
 * constantly.
 */
@Injectable()
export class ListAuditQuery {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async execute(filter: AuditFilter): Promise<AuditPage> {
    const organizationId = requireOrganizationId();
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const conditions = [
      eq(auditLogs.organizationId, organizationId),
      /*
       * Property-scoped rows, plus the organization-wide ones.
       *
       * Team administration and guest edits carry a null propertyId because
       * they are not about one hotel. Filtering them out would hide exactly
       * the entries an audit is usually opened to find — who changed whose
       * role — while looking complete.
       */
      sql`(${auditLogs.propertyId} = ${filter.propertyId} OR ${auditLogs.propertyId} IS NULL)`,
    ];

    if (filter.action) conditions.push(eq(auditLogs.action, filter.action));
    if (filter.entityType) conditions.push(eq(auditLogs.entityType, filter.entityType));
    if (filter.entityId) conditions.push(eq(auditLogs.entityId, filter.entityId));

    if (filter.cursor) {
      const after = decodeCursor(filter.cursor);
      conditions.push(
        sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${after.createdAt}, ${after.id})`,
      );
    }

    // One extra row to learn whether another page exists, without counting.
    const rows = await this.db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        actorType: auditLogs.actorType,
        actorLabel: auditLogs.actorLabel,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        reason: auditLogs.reason,
        before: auditLogs.before,
        after: auditLogs.after,
        requestId: auditLogs.requestId,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
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
