import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  GUEST_REPOSITORY,
  type GuestMergeRecord,
  type GuestRepository,
} from '../domain/guest.repository';
import { reconcile, type MergeableFields } from '../domain/guest-merge';

export interface MergeGuestsInput {
  /** The profile that survives. Named by the caller, never inferred. */
  readonly survivorId: string;
  /** The profile folded into it. */
  readonly duplicateId: string;
}

export interface MergeGuestsResult {
  readonly survivorId: string;
  readonly duplicateId: string;
  readonly reservationsMoved: number;
  /** Which columns the survivor gained, so the screen can say what changed. */
  readonly fieldsFilled: readonly string[];
}

/**
 * Fold one guest profile into another (roadmap Phase 4).
 *
 * The direction is the caller's decision and this use case never guesses it.
 * Picking a survivor by stay count or by age would be defensible and wrong: the
 * operator is looking at both records, knows which spelling is the one the
 * hotel uses, and has to live with the result.
 *
 * Three things happen, in one transaction:
 *
 * 1. Every reservation moves to the survivor. This is the point of the whole
 *    operation — a split history is what makes a returning guest invisible.
 * 2. The survivor fills in its own blanks from the duplicate, and never
 *    overwrites a value it already had. Notes are joined rather than chosen.
 * 3. The duplicate becomes a tombstone pointing at the survivor, rather than
 *    being deleted, so the merge stays answerable afterwards.
 *
 * There is no unmerge. It could be built — the audit entry names every
 * reservation that moved and the tombstone says where it went — but it is a
 * second dangerous operation to get right, and the merge already requires two
 * profiles in front of a person before it will run.
 */
@Injectable()
export class MergeGuestsUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GUEST_REPOSITORY) private readonly repo: GuestRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: MergeGuestsInput, actor: AuditActor): Promise<MergeGuestsResult> {
    const organizationId = requireOrganizationId();

    if (input.survivorId === input.duplicateId) {
      throw errors.validation('A guest cannot be merged into itself');
    }

    return this.db.transaction(async (tx) => {
      // Both rows locked in id order before anything is read, so a concurrent
      // merge of the same pair in the opposite direction waits here rather
      // than producing two tombstones pointing at each other.
      const locked = await this.repo.lockPairForMerge(tx, input.survivorId, input.duplicateId);

      const survivor = locked.find((row) => row.id === input.survivorId);
      const duplicate = locked.find((row) => row.id === input.duplicateId);

      if (!survivor) throw errors.notFound('Guest', input.survivorId);
      if (!duplicate) throw errors.notFound('Guest', input.duplicateId);

      /*
       * Both directions refused, with different reasons, because they are
       * different mistakes. Merging INTO a tombstone would hide the stays
       * behind a profile no read path returns; merging a tombstone that has
       * already gone somewhere else would move history twice.
       */
      if (survivor.mergedIntoId) {
        throw errors.validation(
          'That profile has already been merged into another one. Merge into the surviving profile instead.',
        );
      }
      if (duplicate.mergedIntoId) {
        throw errors.validation('That profile has already been merged into another one');
      }

      const changes = reconcile(survivor as MergeableFields, duplicate as MergeableFields);
      await this.repo.applyMergedFields(tx, survivor.id, changes);

      const moved = await this.repo.reassignReservations(tx, duplicate.id, survivor.id);

      const at = new Date();
      await this.repo.markMerged(tx, duplicate.id, survivor.id, at);

      /*
       * One entry against each profile, because someone investigating later
       * arrives holding one id and not the other — and the whole reason for
       * this trail is that a merge cannot be read back out of the guest rows.
       *
       * The duplicate's entry carries its full former contents, minus the
       * encrypted document number: the audit table is not encrypted, and
       * copying a passport number into it would defeat the column that is.
       */
      const record = {
        organizationId,
        propertyId: null,
        actor,
        entityType: 'guest',
      } as const;

      await this.audit.record(tx, {
        ...record,
        action: 'guest.merged',
        entityId: survivor.id,
        before: { ...redact(survivor) },
        after: {
          mergedFrom: duplicate.id,
          fieldsFilled: Object.keys(changes),
          reservationsMoved: moved,
        },
      });

      await this.audit.record(tx, {
        ...record,
        action: 'guest.merged_away',
        entityId: duplicate.id,
        before: { ...redact(duplicate) },
        after: { mergedInto: survivor.id, reservationsMoved: moved },
      });

      return {
        survivorId: survivor.id,
        duplicateId: duplicate.id,
        reservationsMoved: moved.length,
        fieldsFilled: Object.keys(changes),
      };
    });
  }
}

/** Everything except the one column that is encrypted for a reason. */
function redact(guest: GuestMergeRecord): Record<string, unknown> {
  const { documentNumberEncrypted, ...rest } = guest;
  return { ...rest, hasDocumentNumber: documentNumberEncrypted !== null };
}
