import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import type { Executor } from '../../../database/executor';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  computeTotals,
  type ExtraChargeLine,
  type FolioTotals,
  type PaymentLine,
  type RoomChargeLine,
} from '../domain/folio';
import {
  FOLIO_REPOSITORY,
  type FolioRepository,
  type FolioSubject,
} from '../domain/folio.repository';

export interface Folio {
  readonly reservationId: string;
  readonly code: string;
  readonly status: string;
  readonly bookerName: string;
  readonly currency: string;
  readonly roomCharges: readonly RoomChargeLine[];
  readonly extraCharges: readonly ExtraChargeLine[];
  readonly payments: readonly PaymentLine[];
  readonly totals: FolioTotals;
}

/**
 * The guest's account, assembled from three places.
 *
 * Room charges come from the reservation's frozen nights, extras and payments
 * from their own tables, and the arithmetic from the domain. Nothing here
 * stores a total: a folio recomputed on every read cannot drift from the
 * booking it belongs to, which is the failure mode a stored balance has.
 */
@Injectable()
export class GetFolioQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FOLIO_REPOSITORY) private readonly repo: FolioRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
  ) {}

  async execute(propertyId: string, reservationId: string): Promise<Folio> {
    return this.load(this.db, propertyId, reservationId);
  }

  /** Also used inside a write transaction, to answer with the new state. */
  async load(tx: Executor, propertyId: string, reservationId: string): Promise<Folio> {
    const subject = await this.repo.findSubject(tx, reservationId);
    if (!subject || subject.propertyId !== propertyId) {
      throw errors.notFound('Reservation', reservationId);
    }

    const property = await this.propertyRepo.findProperty(tx, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const [roomCharges, extraCharges, payments] = await Promise.all([
      this.repo.findRoomCharges(tx, reservationId),
      this.repo.findExtraCharges(tx, reservationId),
      this.repo.findPayments(tx, reservationId),
    ]);

    return {
      ...present(subject),
      roomCharges,
      extraCharges,
      payments,
      totals: computeTotals(roomCharges, extraCharges, payments, subject.currency, {
        taxRateBp: property.taxRateBp,
        serviceChargeRateBp: property.serviceChargeRateBp,
        pricesIncludeTax: property.pricesIncludeTax,
      }),
    };
  }
}

function present(subject: FolioSubject) {
  return {
    reservationId: subject.reservationId,
    code: subject.code,
    status: subject.status,
    bookerName: subject.bookerName,
    currency: subject.currency,
  };
}
