import { Inject, Injectable, Logger } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { newId } from '../../../common/ids';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  MEDIA_REPOSITORY,
  type MediaKind,
  type MediaRecord,
  type MediaRepository,
  type UpdateMediaFields,
} from '../domain/media.repository';
import { OBJECT_STORE, type ObjectStore, type UploadGrant } from '../domain/object-store';
import {
  assertImageSize,
  extensionFor,
  MAX_PHOTOS_PER_GALLERY,
  objectKeyFor,
} from '../domain/upload-rules';

export interface GalleryRef {
  readonly propertyId: string;
  readonly kind: MediaKind;
  readonly roomTypeId: string | null;
}

export interface CreateUploadInput extends GalleryRef {
  readonly contentType: string;
  readonly bytes: number;
}

export interface CreateUploadResult {
  readonly mediaId: string;
  readonly objectKey: string;
  readonly upload: UploadGrant;
}

export interface AttachMediaInput extends GalleryRef {
  /** The id the upload grant was issued for. */
  readonly mediaId: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
}

export interface UpdateMediaInput {
  readonly propertyId: string;
  readonly mediaId: string;
  readonly fields: UpdateMediaFields;
}

/**
 * Photos, in two steps that the browser drives.
 *
 * 1. `createUpload` mints an id and a key, and signs a PUT for exactly that
 *    key, type and size. Nothing is written to the database: a grant that is
 *    never used costs nothing and leaves nothing to clean up.
 * 2. `attach` is called after the PUT succeeded. It HEADs the object first —
 *    a row that points at nothing is a broken image on the booking page for
 *    every guest until somebody notices — and refuses if the bytes or type
 *    differ from what was granted.
 *
 * Deleting removes the row and then the object. The order matters: a row
 * without an object is a broken picture, an object without a row is a few
 * hundred kilobytes nobody can see. If the second step fails the orphan is
 * logged and the request still succeeds.
 */
@Injectable()
export class ManageMediaUseCase {
  private readonly logger = new Logger(ManageMediaUseCase.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MEDIA_REPOSITORY) private readonly repo: MediaRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @Inject(PROPERTY_REPOSITORY) private readonly properties: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async createUpload(input: CreateUploadInput): Promise<CreateUploadResult> {
    const organizationId = requireOrganizationId();
    await this.requireGallery(input);
    if (!this.store.isConfigured()) {
      throw errors.conflict('Photo storage is not configured for this deployment');
    }
    extensionFor(input.contentType);
    assertImageSize(input.bytes);

    const taken = await this.repo.count(this.db, input.propertyId, input.kind, input.roomTypeId);
    if (taken >= MAX_PHOTOS_PER_GALLERY) {
      throw errors.validation(`A gallery holds at most ${String(MAX_PHOTOS_PER_GALLERY)} photos`, {
        max: MAX_PHOTOS_PER_GALLERY,
      });
    }

    const mediaId = newId();
    const objectKey = objectKeyFor(organizationId, input.propertyId, mediaId, input.contentType);
    const upload = await this.store.createUploadGrant(objectKey, input.contentType, input.bytes);
    return { mediaId, objectKey, upload };
  }

  async attach(input: AttachMediaInput, actor: AuditActor): Promise<MediaRecord> {
    const organizationId = requireOrganizationId();
    await this.requireGallery(input);

    // The key is recomputed from the id, never accepted from the client: a
    // client naming a key could attach another tenant's object to its page.
    // The extension is unknown until the object is read, so every allowed one
    // is tried; the first that exists is the upload.
    const candidate = await this.findUploaded(organizationId, input.propertyId, input.mediaId);
    if (!candidate) {
      throw errors.validation('The photo was not uploaded, or the upload has not finished', {
        mediaId: input.mediaId,
      });
    }
    assertImageSize(candidate.bytes);

    return this.db.transaction(async (tx) => {
      const sortOrder =
        (await this.repo.maxSortOrder(tx, input.propertyId, input.kind, input.roomTypeId)) + 1;
      const record = {
        id: input.mediaId,
        organizationId,
        propertyId: input.propertyId,
        kind: input.kind,
        roomTypeId: input.roomTypeId,
        objectKey: candidate.objectKey,
        contentType: candidate.contentType,
        bytes: candidate.bytes,
        width: input.width,
        height: input.height,
        alt: input.alt,
        sortOrder,
      };
      await this.repo.insert(tx, record);
      await this.audit.record(tx, {
        organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'media.attached',
        entityType: 'media',
        entityId: input.mediaId,
        after: { ...record },
      });
      const stored = await this.repo.findById(tx, input.propertyId, input.mediaId);
      if (!stored) throw errors.notFound('Media', input.mediaId);
      return stored;
    });
  }

  async update(input: UpdateMediaInput, actor: AuditActor): Promise<MediaRecord> {
    const organizationId = requireOrganizationId();
    if (Object.keys(input.fields).length === 0) throw errors.validation('No fields to update');

    return this.db.transaction(async (tx) => {
      const before = await this.repo.findById(tx, input.propertyId, input.mediaId);
      if (!before) throw errors.notFound('Media', input.mediaId);
      await this.repo.update(tx, input.propertyId, input.mediaId, input.fields);
      const after = await this.repo.findById(tx, input.propertyId, input.mediaId);
      if (!after) throw errors.notFound('Media', input.mediaId);
      await this.audit.record(tx, {
        organizationId,
        propertyId: input.propertyId,
        actor,
        action: 'media.updated',
        entityType: 'media',
        entityId: input.mediaId,
        before: { alt: before.alt, sortOrder: before.sortOrder },
        after: { alt: after.alt, sortOrder: after.sortOrder },
      });
      return after;
    });
  }

  async remove(propertyId: string, mediaId: string, actor: AuditActor): Promise<void> {
    const organizationId = requireOrganizationId();

    const record = await this.db.transaction(async (tx) => {
      const existing = await this.repo.findById(tx, propertyId, mediaId);
      if (!existing) throw errors.notFound('Media', mediaId);
      await this.repo.delete(tx, propertyId, mediaId);
      await this.audit.record(tx, {
        organizationId,
        propertyId,
        actor,
        action: 'media.deleted',
        entityType: 'media',
        entityId: mediaId,
        before: { ...existing },
      });
      return existing;
    });

    try {
      await this.store.delete(record.objectKey);
    } catch (error) {
      // The row is gone, so nothing shows a broken image. The bytes linger.
      this.logger.warn(`Orphaned object ${record.objectKey} after delete: ${String(error)}`);
    }
  }

  private async findUploaded(
    organizationId: string,
    propertyId: string,
    mediaId: string,
  ): Promise<{ objectKey: string; bytes: number; contentType: string } | null> {
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      const objectKey = objectKeyFor(organizationId, propertyId, mediaId, contentType);
      const stored = await this.store.head(objectKey);
      if (stored) return { objectKey, bytes: stored.bytes, contentType: stored.contentType };
    }
    return null;
  }

  private async requireGallery(ref: GalleryRef): Promise<void> {
    const property = await this.properties.findProperty(this.db, ref.propertyId);
    if (!property) throw errors.notFound('Property', ref.propertyId);

    if (ref.kind === 'ROOM_TYPE') {
      if (!ref.roomTypeId) throw errors.validation('A room photo needs a room type');
      const roomType = await this.properties.findRoomType(this.db, ref.roomTypeId);
      if (!roomType || roomType.propertyId !== ref.propertyId) {
        throw errors.notFound('Room type', ref.roomTypeId);
      }
    } else if (ref.roomTypeId) {
      throw errors.validation('A property photo does not belong to a room type');
    }
  }
}
