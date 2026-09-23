import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { media } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type {
  CreateMediaRecord,
  MediaKind,
  MediaRecord,
  MediaRepository,
  UpdateMediaFields,
} from '../domain/media.repository';

const COLUMNS = {
  id: media.id,
  propertyId: media.propertyId,
  kind: media.kind,
  roomTypeId: media.roomTypeId,
  objectKey: media.objectKey,
  contentType: media.contentType,
  bytes: media.bytes,
  width: media.width,
  height: media.height,
  alt: media.alt,
  sortOrder: media.sortOrder,
  createdAt: media.createdAt,
};

function present(
  row: typeof COLUMNS extends infer _ ? Record<string, unknown> : never,
): MediaRecord {
  return { ...(row as unknown as MediaRecord), kind: row['kind'] as MediaKind };
}

@Injectable()
export class DrizzleMediaRepository implements MediaRepository {
  async list(tx: Executor, propertyId: string): Promise<readonly MediaRecord[]> {
    const rows = await tx
      .select(COLUMNS)
      .from(media)
      .where(this.scope(propertyId))
      .orderBy(asc(media.kind), asc(media.roomTypeId), asc(media.sortOrder), asc(media.createdAt));
    return rows.map(present);
  }

  async findById(tx: Executor, propertyId: string, mediaId: string): Promise<MediaRecord | null> {
    const rows = await tx
      .select(COLUMNS)
      .from(media)
      .where(and(this.scope(propertyId), eq(media.id, mediaId)))
      .limit(1);
    return rows[0] ? present(rows[0]) : null;
  }

  async insert(tx: Executor, record: CreateMediaRecord): Promise<void> {
    await tx.insert(media).values(record);
  }

  async update(
    tx: Executor,
    propertyId: string,
    mediaId: string,
    fields: UpdateMediaFields,
  ): Promise<void> {
    await tx
      .update(media)
      .set(fields)
      .where(and(this.scope(propertyId), eq(media.id, mediaId)));
  }

  async delete(tx: Executor, propertyId: string, mediaId: string): Promise<void> {
    await tx.delete(media).where(and(this.scope(propertyId), eq(media.id, mediaId)));
  }

  async maxSortOrder(
    tx: Executor,
    propertyId: string,
    kind: MediaKind,
    roomTypeId: string | null,
  ): Promise<number> {
    const rows = await tx
      .select({ value: sql<number>`coalesce(max(${media.sortOrder}), -1)::int` })
      .from(media)
      .where(this.gallery(propertyId, kind, roomTypeId));
    return rows[0]?.value ?? -1;
  }

  async count(
    tx: Executor,
    propertyId: string,
    kind: MediaKind,
    roomTypeId: string | null,
  ): Promise<number> {
    const rows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(media)
      .where(this.gallery(propertyId, kind, roomTypeId));
    return rows[0]?.value ?? 0;
  }

  private gallery(propertyId: string, kind: MediaKind, roomTypeId: string | null) {
    return and(
      this.scope(propertyId),
      eq(media.kind, kind),
      roomTypeId === null ? isNull(media.roomTypeId) : eq(media.roomTypeId, roomTypeId),
    );
  }

  private scope(propertyId: string) {
    return and(eq(media.organizationId, requireOrganizationId()), eq(media.propertyId, propertyId));
  }
}
