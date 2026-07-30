import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { businessDate, errors, toIsoDate, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { requireTenant } from '../../../common/tenant/tenant-context';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { physicalRooms, reservationStays } from '../../../database/schema';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  RESERVATION_REPOSITORY,
  type ReservationRepository,
} from '../domain/reservation.repository';
import { assertTransition, type ReservationStatus } from '../domain/reservation-status';

export interface CheckInInput {
  readonly propertyId: string;
  readonly reservationId: string;
  readonly expectedVersion: number;
}

export interface CheckInResult {
  readonly id: string;
  readonly status: 'CHECKED_IN';
  readonly checkedInAt: Date;
  readonly rooms: readonly string[];
}

/**
 * Check a booking in.
 *
 * Status lives on the reservation, not the stay, so a multi-room booking
 * arrives as one party. That matches how a family or a tour group actually
 * turns up at a desk; splitting it would need a per-stay status and is not
 * worth the complexity until a hotel asks for it.
 */
@Injectable()
export class CheckInUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RESERVATION_REPOSITORY) private readonly reservations: ReservationRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: CheckInInput, actor: AuditActor): Promise<CheckInResult> {
    const tenant = requireTenant();

    const reservation = await this.reservations.findById(this.db, input.reservationId);
    if (!reservation || reservation.propertyId !== input.propertyId) {
      throw errors.notFound('Reservation', input.reservationId);
    }

    // The domain decides, not the UI: an OTA webhook or a stale browser tab
    // must not be able to check in something cancelled.
    assertTransition(reservation.status as ReservationStatus, 'CHECKED_IN');

    const property = await this.properties.findProperty(this.db, input.propertyId);
    if (!property) throw errors.notFound('Property', input.propertyId);

    const stays = await this.db
      .select({
        id: reservationStays.id,
        checkIn: reservationStays.checkIn,
        assignedRoomId: reservationStays.assignedRoomId,
        roomNumber: physicalRooms.roomNumber,
        housekeepingStatus: physicalRooms.housekeepingStatus,
      })
      .from(reservationStays)
      .leftJoin(physicalRooms, eq(physicalRooms.id, reservationStays.assignedRoomId))
      .where(
        and(
          eq(reservationStays.organizationId, tenant.organizationId),
          eq(reservationStays.reservationId, input.reservationId),
        ),
      );

    if (stays.length === 0) throw errors.validation('This reservation has no rooms booked');

    // Every room, not just one. Checking in a three-room booking with two rooms
    // assigned leaves a guest standing in reception with nowhere to sleep.
    const unassigned = stays.filter((stay) => stay.assignedRoomId === null);
    if (unassigned.length > 0) {
      throw errors.validation(
        `Assign a room to every part of this booking first — ${String(unassigned.length)} still has none`,
        { unassignedStays: unassigned.map((stay) => stay.id) },
      );
    }

    // Today in the PROPERTY's timezone. A Bangkok hotel served from a
    // us-central1 instance must not think it is still yesterday.
    const today: IsoDate = businessDate(property.timezone);
    const earliest = stays
      .map((stay) => toIsoDate(stay.checkIn))
      .reduce((min, date) => (date < min ? date : min));

    // Early arrival on the day is normal; checking in a booking that arrives
    // next week is someone clicking the wrong row.
    if (earliest > today) {
      throw errors.validation(`This booking arrives on ${earliest}, not today`, {
        arrivesOn: earliest,
        today,
      });
    }

    const now = new Date();

    return this.db.transaction(async (tx) => {
      const updated = await this.reservations.updateStatus(
        tx,
        reservation.id,
        input.expectedVersion,
        'CHECKED_IN',
        { checkedInAt: now },
      );
      if (updated !== 1) {
        throw errors.versionMismatch(input.expectedVersion, reservation.version);
      }

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'reservation.checked_in',
        entityType: 'reservation',
        entityId: reservation.id,
        before: { status: reservation.status },
        after: {
          status: 'CHECKED_IN',
          checkedInAt: now.toISOString(),
          rooms: stays.map((stay) => stay.roomNumber),
          // Worth recording: a guest put into a room nobody had cleaned is the
          // sort of thing a manager asks about the next morning.
          roomsNotClean: stays
            .filter((stay) => stay.housekeepingStatus === 'DIRTY')
            .map((stay) => stay.roomNumber),
        },
      });

      return {
        id: reservation.id,
        status: 'CHECKED_IN' as const,
        checkedInAt: now,
        rooms: stays.map((stay) => stay.roomNumber ?? ''),
      };
    });
  }
}
