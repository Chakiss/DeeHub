import { Body, Controller, Get, Inject, Param, Patch, Query, Req } from '@nestjs/common';
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

/** Enough for a front desk to find someone; not a bulk export. */
const MAX_RESULTS = 50;

@ApiTags('guests')
@Controller('properties/:propertyId/guests')
export class GuestsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GUEST_REPOSITORY) private readonly repo: GuestRepository,
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

  // No DELETE: reservations point at a guest, and removing the profile would
  // detach a stay from who took it.
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
