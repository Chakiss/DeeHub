import { Injectable } from '@nestjs/common';
import { newId } from '../ids';
import { auditLogs } from '../../database/schema';
import type { Executor } from '../../database/executor';

export type ActorType = 'USER' | 'SYSTEM' | 'CHANNEL';

export interface AuditActor {
  readonly type: ActorType;
  readonly id: string | null;
  readonly label: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface AuditEntry {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly actor: AuditActor;
  /** Dotted action name, e.g. 'reservation.cancelled'. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly reason?: string | null;
}

/**
 * Append-only audit trail (Definition of Done: every state change is audited).
 *
 * Written inside the same transaction as the change it describes, so the
 * history cannot disagree with the data.
 */
@Injectable()
export class AuditService {
  async record(tx: Executor, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLogs).values({
      id: newId(),
      organizationId: entry.organizationId,
      propertyId: entry.propertyId,
      actorType: entry.actor.type,
      actorUserId: entry.actor.id,
      actorLabel: entry.actor.label,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason ?? null,
      ip: entry.actor.ip ?? null,
      userAgent: entry.actor.userAgent ?? null,
      requestId: entry.actor.requestId ?? null,
    });
  }
}
