import type { Executor } from '../../../database/executor';

export const MEDIA_KINDS = ['PROPERTY', 'ROOM_TYPE'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface MediaRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly kind: MediaKind;
  readonly roomTypeId: string | null;
  readonly objectKey: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
  readonly sortOrder: number;
  readonly createdAt: Date;
}

export interface CreateMediaRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly kind: MediaKind;
  readonly roomTypeId: string | null;
  readonly objectKey: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly alt: string | null;
  readonly sortOrder: number;
}

export type UpdateMediaFields = Partial<Pick<MediaRecord, 'alt' | 'sortOrder'>>;

/**
 * Photo rows. Organization-scoped from the ambient tenant context (ADR-0001).
 *
 * The public booking page reads these too, but through its own resolver with
 * an explicit tenant — never through an unscoped query.
 */
export interface MediaRepository {
  list(tx: Executor, propertyId: string): Promise<readonly MediaRecord[]>;
  findById(tx: Executor, propertyId: string, mediaId: string): Promise<MediaRecord | null>;
  insert(tx: Executor, record: CreateMediaRecord): Promise<void>;
  update(
    tx: Executor,
    propertyId: string,
    mediaId: string,
    fields: UpdateMediaFields,
  ): Promise<void>;
  delete(tx: Executor, propertyId: string, mediaId: string): Promise<void>;
  /** Highest sortOrder within one gallery (property, or one room type). */
  maxSortOrder(
    tx: Executor,
    propertyId: string,
    kind: MediaKind,
    roomTypeId: string | null,
  ): Promise<number>;
  /** How many photos a gallery already holds — the cap is enforced on it. */
  count(
    tx: Executor,
    propertyId: string,
    kind: MediaKind,
    roomTypeId: string | null,
  ): Promise<number>;
}

export const MEDIA_REPOSITORY = Symbol('MEDIA_REPOSITORY');
