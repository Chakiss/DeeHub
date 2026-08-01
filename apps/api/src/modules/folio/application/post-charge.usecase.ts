import { Inject, Injectable } from '@nestjs/common';
import { businessDate, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import type { FolioChargeKind } from '../domain/folio';
import { FOLIO_REPOSITORY, type FolioRepository } from '../domain/folio.repository';
import { GetFolioQuery, type Folio } from './get-folio.query';

export interface PostChargeInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly kind: FolioChargeKind;
  readonly description: string | null;
  readonly amountMinor: number;
  readonly taxable: boolean;
}

/**
 * Bookings whose account is still open.
 *
 * A cancelled booking is closed to new charges: whatever it was going to cost
 * the guest is now a cancellation fee, which is a decision the hotel makes
 * deliberately rather than by adding a minibar line to a stay nobody took.
 *
 * A CHECKED_OUT booking IS still open, and that is on purpose. The minibar gets
 * checked after the guest leaves, the card is charged afterwards, and refusing
 * the line would send the front desk to a spreadsheet.
 */
const OPEN_STATUSES = new Set(['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW']);

/**
 * Put something on the guest's bill that is not a room night.
 *
 * The amount is what the guest is charged. Whether tax composes on top of it or
 * is already inside it follows the property's `pricesIncludeTax`, exactly as
 * room rates do — one convention for the whole bill, so a printed folio adds up
 * the way a guest expects.
 */
@Injectable()
export class PostChargeUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FOLIO_REPOSITORY) private readonly repo: FolioRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly folio: GetFolioQuery,
    private readonly audit: AuditService,
  ) {}

  async execute(input: PostChargeInput, actor: AuditActor, now: Date = new Date()): Promise<Folio> {
    const tenant = requireTenant();

    return this.db.transaction(async (tx) => {
      const subject = await this.repo.findSubject(tx, input.reservationId);
      if (!subject || subject.propertyId !== input.propertyId) {
        throw errors.notFound('Reservation', input.reservationId);
      }
      if (!OPEN_STATUSES.has(subject.status)) {
        throw errors.conflict(`Nothing can be charged to a ${subject.status} booking`, {
          reservationId: subject.reservationId,
          status: subject.status,
        });
      }

      const property = await this.propertyRepo.findProperty(tx, input.propertyId);
      if (!property) throw errors.notFound('Property', input.propertyId);

      const chargeId = newId();
      await this.repo.insertCharge(tx, {
        id: chargeId,
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        reservationId: input.reservationId,
        kind: input.kind,
        description: input.description,
        amountMinor: input.amountMinor,
        currency: subject.currency,
        taxable: input.taxable,
        // The property's trading day, not the server's calendar (ADR-0003).
        businessDate: businessDate(property.timezone, now),
        postedByUserId: actor.type === 'USER' ? actor.id : null,
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'folio.charge_posted',
        entityType: 'reservation',
        entityId: input.reservationId,
        after: {
          chargeId,
          kind: input.kind,
          amountMinor: input.amountMinor,
          taxable: input.taxable,
          description: input.description,
        },
      });

      // Read back inside the transaction: the caller gets the balance including
      // what they just posted, rather than a number that is already one line
      // out of date by the time it reaches the screen.
      return this.folio.load(tx, input.propertyId, input.reservationId);
    });
  }
}
