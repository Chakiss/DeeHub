import { Inject, Injectable } from '@nestjs/common';
import { DomainError, errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { isUniqueViolation } from '../../../common/database/unique-violation';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  BOOKING_SOURCE_REPOSITORY,
  DEFAULT_BOOKING_SOURCES,
  type BookingSourceKind,
  type BookingSourceRecord,
  type BookingSourceRepository,
  type UpdateBookingSourceFields,
} from '../domain/booking-source.repository';

export interface CreateBookingSourceInput {
  readonly propertyId: string;
  readonly name: string;
  readonly kind: BookingSourceKind;
}

export interface UpdateBookingSourceInput {
  readonly propertyId: string;
  readonly sourceId: string;
  readonly fields: UpdateBookingSourceFields;
}

const NAME_CONSTRAINT = 'booking_sources_property_name_uq';

/**
 * The list a property keeps of where its bookings come from.
 *
 * Small on purpose. No delete: reservations point at these and "how much did
 * Agoda bring in last year" must keep working after the hotel stops selling
 * there — `isActive: false` takes a source off the form and keeps the history.
 * No changing the kind either, for the same reason: every booking that named
 * this source recorded its category from it.
 */
@Injectable()
export class ManageBookingSourcesUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BOOKING_SOURCE_REPOSITORY) private readonly repo: BookingSourceRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async create(input: CreateBookingSourceInput, actor: AuditActor): Promise<BookingSourceRecord> {
    const organizationId = requireOrganizationId();
    await this.requireProperty(input.propertyId);

    const name = input.name.trim();
    const id = newId();

    try {
      return await this.db.transaction(async (tx) => {
        const record = {
          id,
          organizationId,
          propertyId: input.propertyId,
          name,
          kind: input.kind,
          channelType: null,
        };
        await this.repo.insert(tx, record);
        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'booking_source.created',
          entityType: 'booking_source',
          entityId: id,
          after: { ...record },
        });
        return this.readBack(tx, input.propertyId, id);
      });
    } catch (error) {
      if (isUniqueViolation(error, NAME_CONSTRAINT)) {
        throw errors.conflict(`A booking source named ${name} already exists`, { name });
      }
      throw error;
    }
  }

  async update(input: UpdateBookingSourceInput, actor: AuditActor): Promise<BookingSourceRecord> {
    const organizationId = requireOrganizationId();

    const before = await this.repo.findById(this.db, input.propertyId, input.sourceId);
    if (!before) throw errors.notFound('Booking source', input.sourceId);

    const fields: UpdateBookingSourceFields = {
      ...(input.fields.name !== undefined ? { name: input.fields.name.trim() } : {}),
      ...(input.fields.isActive !== undefined ? { isActive: input.fields.isActive } : {}),
    };
    if (Object.keys(fields).length === 0) throw errors.validation('No fields to update');

    try {
      return await this.db.transaction(async (tx) => {
        await this.repo.update(tx, input.propertyId, input.sourceId, fields);
        const after = await this.readBack(tx, input.propertyId, input.sourceId);
        await this.audit.record(tx, {
          organizationId,
          propertyId: input.propertyId,
          actor,
          action: 'booking_source.updated',
          entityType: 'booking_source',
          entityId: input.sourceId,
          before: { ...before },
          after: { ...after },
        });
        return after;
      });
    } catch (error) {
      if (isUniqueViolation(error, NAME_CONSTRAINT)) {
        throw errors.conflict('Another booking source at this property already has that name');
      }
      throw error;
    }
  }

  /**
   * Add the usual OTAs to a property that lacks them. Idempotent: a source
   * already present — by connector type, or by name for the ones without a
   * connector — is left alone, active or not. What a property retired stays
   * retired.
   */
  async addDefaults(propertyId: string, actor: AuditActor): Promise<readonly BookingSourceRecord[]> {
    const organizationId = requireOrganizationId();
    await this.requireProperty(propertyId);

    return this.db.transaction(async (tx) => {
      const existing = await this.repo.list(tx, propertyId);
      const byType = new Set(existing.map((source) => source.channelType).filter(Boolean));
      const byName = new Set(existing.map((source) => source.name.toLowerCase()));
      const added: string[] = [];

      for (const preset of DEFAULT_BOOKING_SOURCES) {
        if (preset.channelType ? byType.has(preset.channelType) : false) continue;
        if (byName.has(preset.name.toLowerCase())) continue;
        const id = newId();
        await this.repo.insert(tx, {
          id,
          organizationId,
          propertyId,
          name: preset.name,
          kind: 'OTA',
          channelType: preset.channelType,
        });
        added.push(preset.name);
      }

      if (added.length > 0) {
        await this.audit.record(tx, {
          organizationId,
          propertyId,
          actor,
          action: 'booking_source.defaults_added',
          entityType: 'property',
          entityId: propertyId,
          after: { added },
        });
      }
      return this.repo.list(tx, propertyId);
    });
  }

  /** A property in another tenant is indistinguishable from one that does not exist. */
  private async requireProperty(propertyId: string): Promise<void> {
    const property = await this.properties.findProperty(this.db, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);
  }

  private async readBack(
    tx: Parameters<BookingSourceRepository['findById']>[0],
    propertyId: string,
    id: string,
  ): Promise<BookingSourceRecord> {
    const record = await this.repo.findById(tx, propertyId, id);
    if (!record) {
      throw new DomainError('INTERNAL_ERROR', 'Booking source could not be read back');
    }
    return record;
  }
}
