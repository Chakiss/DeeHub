import type { Executor } from '../../../database/executor';

/**
 * What kind of thing a booking source is. Each kind pairs with one value of
 * `reservations.source`: an OTA source belongs on an OTA booking and a travel
 * agent on a TRAVEL_AGENT one. The pairing is enforced when a booking is
 * created, not by the database, because the two live in different tables.
 */
export const BOOKING_SOURCE_KINDS = ['OTA', 'TRAVEL_AGENT'] as const;
export type BookingSourceKind = (typeof BOOKING_SOURCE_KINDS)[number];

export interface BookingSourceRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly name: string;
  readonly kind: BookingSourceKind;
  /** The connector type this label stands for, when there is one. */
  readonly channelType: string | null;
  readonly isActive: boolean;
}

export interface CreateBookingSourceRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly name: string;
  readonly kind: BookingSourceKind;
  readonly channelType: string | null;
}

export type UpdateBookingSourceFields = Partial<Pick<BookingSourceRecord, 'name' | 'isActive'>>;

/**
 * The OTAs a Thai hotel sells through before it has a connector to any of
 * them. Every property starts with these; the desk can retire the ones it
 * does not use. Traveloka has no connector type yet, so it is a label only.
 */
export const DEFAULT_BOOKING_SOURCES: readonly {
  readonly name: string;
  readonly channelType: string | null;
}[] = [
  { name: 'Agoda', channelType: 'AGODA' },
  { name: 'Booking.com', channelType: 'BOOKING_COM' },
  { name: 'Expedia', channelType: 'EXPEDIA' },
  { name: 'Trip.com', channelType: 'TRIP_COM' },
  { name: 'Airbnb', channelType: 'AIRBNB' },
  { name: 'Traveloka', channelType: null },
];

export interface BookingSourceRepository {
  list(tx: Executor, propertyId: string): Promise<readonly BookingSourceRecord[]>;
  findById(tx: Executor, propertyId: string, sourceId: string): Promise<BookingSourceRecord | null>;
  findByChannelType(
    tx: Executor,
    propertyId: string,
    channelType: string,
  ): Promise<BookingSourceRecord | null>;
  insert(tx: Executor, record: CreateBookingSourceRecord): Promise<void>;
  update(
    tx: Executor,
    propertyId: string,
    sourceId: string,
    fields: UpdateBookingSourceFields,
  ): Promise<void>;
}

export const BOOKING_SOURCE_REPOSITORY = Symbol('BOOKING_SOURCE_REPOSITORY');
