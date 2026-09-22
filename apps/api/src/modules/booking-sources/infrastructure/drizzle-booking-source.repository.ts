import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { bookingSources } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  BookingSourceKind,
  BookingSourceRecord,
  BookingSourceRepository,
  CreateBookingSourceRecord,
  UpdateBookingSourceFields,
} from '../domain/booking-source.repository';

const COLUMNS = {
  id: bookingSources.id,
  propertyId: bookingSources.propertyId,
  name: bookingSources.name,
  kind: bookingSources.kind,
  channelType: bookingSources.channelType,
  isActive: bookingSources.isActive,
};

@Injectable()
export class DrizzleBookingSourceRepository implements BookingSourceRepository {
  async list(tx: Executor, propertyId: string): Promise<readonly BookingSourceRecord[]> {
    const rows = await tx
      .select(COLUMNS)
      .from(bookingSources)
      .where(this.scope(propertyId))
      // OTAs first, then agents; alphabetical within each. The order a select
      // shows them in.
      .orderBy(asc(bookingSources.kind), asc(bookingSources.name));
    return rows.map(present);
  }

  async findById(
    tx: Executor,
    propertyId: string,
    sourceId: string,
  ): Promise<BookingSourceRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(bookingSources)
      .where(and(this.scope(propertyId), eq(bookingSources.id, sourceId)))
      .limit(1);
    const row = rows[0];
    return row ? present(row) : null;
  }

  async findByChannelType(
    tx: Executor,
    propertyId: string,
    channelType: string,
  ): Promise<BookingSourceRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(bookingSources)
      .where(and(this.scope(propertyId), eq(bookingSources.channelType, channelType)))
      .limit(1);
    const row = rows[0];
    return row ? present(row) : null;
  }

  async insert(tx: Executor, record: CreateBookingSourceRecord): Promise<void> {
    await tx.insert(bookingSources).values(record);
  }

  async update(
    tx: Executor,
    propertyId: string,
    sourceId: string,
    fields: UpdateBookingSourceFields,
  ): Promise<void> {
    await tx
      .update(bookingSources)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(this.scope(propertyId), eq(bookingSources.id, sourceId)));
  }

  /** Organization AND property: the organization clause is the tenant boundary. */
  private scope(propertyId: string) {
    return and(
      eq(bookingSources.organizationId, requireOrganizationId()),
      eq(bookingSources.propertyId, propertyId),
    );
  }
}

function present(row: {
  id: string;
  propertyId: string;
  name: string;
  kind: string;
  channelType: string | null;
  isActive: boolean;
}): BookingSourceRecord {
  return { ...row, kind: row.kind as BookingSourceKind };
}
