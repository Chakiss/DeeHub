import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { errors } from '@deehub/shared';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { AuditService } from '../../../common/audit/audit.service';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  GUEST_REPOSITORY,
  type GuestRepository,
  type GuestSummary,
} from '../domain/guest.repository';
import { FindDuplicatesQuery } from '../application/find-duplicates.query';
import { MergeGuestsUseCase } from '../application/merge-guests.usecase';

const updateSchema = z
  .object({
    firstName: z.string().trim().min(1).max(120).optional(),
    lastName: z.string().trim().max(120).nullable().optional(),
    email: z.string().trim().max(320).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

type UpdateBody = z.infer<typeof updateSchema>;

/**
 * The survivor is the guest in the path; the duplicate is named in the body.
 *
 * Deliberately explicit rather than "merge these two and pick one" — the
 * direction decides whose spelling, whose email and whose notes lead, and it is
 * the operator looking at both records who knows.
 */
const mergeSchema = z.object({ duplicateId: z.string().uuid() }).strict();

type MergeBody = z.infer<typeof mergeSchema>;

/** Enough for a front desk to find someone; not a bulk export. */
const MAX_RESULTS = 50;

@ApiTags('guests')
@Controller('properties/:propertyId/guests')
export class GuestsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GUEST_REPOSITORY) private readonly repo: GuestRepository,
    private readonly duplicates: FindDuplicatesQuery,
    private readonly merge: MergeGuestsUseCase,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireCapability('guest:read')
  @ApiOperation({ summary: 'Search guests by name, email or phone' })
  async list(@Param('propertyId') propertyId: string, @Query('q') q?: string) {
    const rows = await this.repo.search(this.db, propertyId, q?.trim() || null, MAX_RESULTS);
    return { items: rows.map((row) => present(row)) };
  }

  @Get(':guestId')
  @RequireCapability('guest:read')
  @ApiOperation({ summary: 'One guest, with how often they have stayed' })
  async byId(@Param('guestId') guestId: string) {
    const guest = await this.repo.findById(this.db, guestId);
    if (!guest) throw errors.notFound('Guest', guestId);
    return present(guest);
  }

  @Get(':guestId/duplicates')
  @RequireCapability('guest:read')
  @ApiOperation({ summary: 'Other profiles that might be the same person' })
  async duplicatesFor(@Param('guestId') guestId: string) {
    const candidates = await this.duplicates.execute(guestId);
    return {
      items: candidates.map((candidate) => ({
        // The same shape the list uses, minus the stay statistics: this is a
        // decision about identity, and a stay count does not inform it.
        id: candidate.guest.id,
        firstName: candidate.guest.firstName,
        lastName: candidate.guest.lastName,
        email: candidate.guest.email,
        phone: candidate.guest.phone,
        nationality: candidate.guest.nationality,
        notes: candidate.guest.notes,
        signals: candidate.signals,
        confidence: candidate.confidence,
      })),
    };
  }

  /**
   * `guest:update` rather than a capability of its own.
   *
   * A merge is a heavier edit than correcting a spelling, and there was an
   * argument for restricting it further. It lost: the people who notice a
   * duplicate are the front desk seeing the same guest twice, and a permission
   * only a manager holds means the duplicate is never fixed.
   */
  @Post(':guestId/merge')
  @RequireCapability('guest:update')
  @ApiOperation({ summary: 'Fold another profile into this one' })
  async mergeInto(
    @Param('guestId') guestId: string,
    @Body(new ZodValidationPipe(mergeSchema)) body: MergeBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const result = await this.merge.execute(
      { survivorId: guestId, duplicateId: body.duplicateId },
      actorFrom(request),
    );

    const survivor = await this.repo.findById(this.db, result.survivorId);
    if (!survivor) throw errors.notFound('Guest', result.survivorId);

    return {
      guest: present(survivor),
      reservationsMoved: result.reservationsMoved,
      fieldsFilled: result.fieldsFilled,
    };
  }

  // No DELETE: reservations point at a guest, and removing the profile would
  // detach a stay from who took it. A duplicate is merged, not deleted.
  @Patch(':guestId')
  @RequireCapability('guest:update')
  @ApiOperation({ summary: 'Correct a guest profile' })
  async update(
    @Param('guestId') guestId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, guestId);
    if (!before) throw errors.notFound('Guest', guestId);
    if (Object.keys(body).length === 0) throw errors.validation('No fields to update');

    return this.db.transaction(async (tx) => {
      await this.repo.update(tx, guestId, body);

      const after = await this.repo.findById(tx, guestId);
      if (!after) throw errors.notFound('Guest', guestId);

      await this.audit.record(tx, {
        organizationId,
        propertyId: null,
        actor: actorFrom(request),
        action: 'guest.updated',
        entityType: 'guest',
        entityId: guestId,
        before: { ...before },
        after: { ...after },
      });

      return present(after);
    });
  }
}

/**
 * Explicit shape. The row carries an encrypted document number, and an
 * accidental serialisation of the whole record is exactly how that leaves the
 * building.
 */
function present(guest: GuestSummary) {
  return {
    id: guest.id,
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    phone: guest.phone,
    nationality: guest.nationality,
    notes: guest.notes,
    stays: guest.stays,
    lastStay: guest.lastStay,
    revenueMinor: guest.revenueMinor,
    possibleDuplicates: guest.possibleDuplicates,
  };
}
