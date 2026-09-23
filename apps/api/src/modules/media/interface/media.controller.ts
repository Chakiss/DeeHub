import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';
import { RequireCapability, type AuthenticatedRequest } from '../../../common/guards/auth.guard';
import { actorFrom } from '../../inventory/interface/inventory.controller';
import { DATABASE, type Database } from '../../../database/database.module';
import { ManageMediaUseCase } from '../application/manage-media.usecase';
import {
  MEDIA_KINDS,
  MEDIA_REPOSITORY,
  type MediaRecord,
  type MediaRepository,
} from '../domain/media.repository';
import { OBJECT_STORE, type ObjectStore } from '../domain/object-store';
import { MAX_IMAGE_BYTES, MAX_PHOTOS_PER_GALLERY } from '../domain/upload-rules';

const gallery = {
  kind: z.enum(MEDIA_KINDS),
  roomTypeId: z.string().uuid().nullable().optional(),
};

const uploadSchema = z
  .object({
    ...gallery,
    contentType: z.string().min(1).max(100),
    bytes: z.number().int().positive(),
  })
  .strict();

const attachSchema = z
  .object({
    ...gallery,
    mediaId: z.string().uuid(),
    width: z.number().int().positive().max(20000).nullable().optional(),
    height: z.number().int().positive().max(20000).nullable().optional(),
    alt: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    alt: z.string().trim().max(200).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();

type UploadBody = z.infer<typeof uploadSchema>;
type AttachBody = z.infer<typeof attachSchema>;
type UpdateBody = z.infer<typeof updateSchema>;

/**
 * Photos of the property and its room types. Setup, not front-desk work, so
 * writes ride on `property:update`; the list is part of seeing the property.
 */
@ApiTags('media')
@Controller('properties/:propertyId/media')
export class MediaController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MEDIA_REPOSITORY) private readonly repo: MediaRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly manage: ManageMediaUseCase,
  ) {}

  @Get()
  @RequireCapability('property:read')
  @ApiOperation({ summary: 'Photos of a property and its room types' })
  async list(@Param('propertyId') propertyId: string) {
    const rows = await this.repo.list(this.db, propertyId);
    return {
      items: rows.map((row) => this.present(row)),
      // The dashboard shows an explanation instead of an upload button when
      // no store is configured, and enforces the same limits before sending.
      storageAvailable: this.store.isConfigured(),
      limits: { maxBytes: MAX_IMAGE_BYTES, maxPerGallery: MAX_PHOTOS_PER_GALLERY },
    };
  }

  @Post('uploads')
  @RequireCapability('property:update')
  @ApiOperation({ summary: 'Sign a direct-to-storage upload for one photo' })
  async createUpload(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(uploadSchema)) body: UploadBody,
  ) {
    const result = await this.manage.createUpload({
      propertyId,
      kind: body.kind,
      roomTypeId: body.roomTypeId ?? null,
      contentType: body.contentType,
      bytes: body.bytes,
    });
    return {
      mediaId: result.mediaId,
      uploadUrl: result.upload.url,
      headers: result.upload.headers,
      expiresAt: result.upload.expiresAt.toISOString(),
    };
  }

  @Post()
  @RequireCapability('property:update')
  @ApiOperation({ summary: 'Record an uploaded photo so pages can show it' })
  async attach(
    @Param('propertyId') propertyId: string,
    @Body(new ZodValidationPipe(attachSchema)) body: AttachBody,
    @Req() request: AuthenticatedRequest,
  ) {
    const row = await this.manage.attach(
      {
        propertyId,
        kind: body.kind,
        roomTypeId: body.roomTypeId ?? null,
        mediaId: body.mediaId,
        width: body.width ?? null,
        height: body.height ?? null,
        alt: body.alt ?? null,
      },
      actorFrom(request),
    );
    return this.present(row);
  }

  @Patch(':mediaId')
  @RequireCapability('property:update')
  @ApiOperation({ summary: 'Reorder a photo or change its caption' })
  async update(
    @Param('propertyId') propertyId: string,
    @Param('mediaId') mediaId: string,
    @Body(new ZodValidationPipe(updateSchema)) body: UpdateBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.present(
      await this.manage.update({ propertyId, mediaId, fields: body }, actorFrom(request)),
    );
  }

  @Delete(':mediaId')
  @HttpCode(204)
  @RequireCapability('property:update')
  @ApiOperation({ summary: 'Remove a photo' })
  async remove(
    @Param('propertyId') propertyId: string,
    @Param('mediaId') mediaId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    await this.manage.remove(propertyId, mediaId, actorFrom(request));
  }

  private present(row: MediaRecord) {
    return {
      id: row.id,
      kind: row.kind,
      roomTypeId: row.roomTypeId,
      url: this.store.publicUrl(row.objectKey),
      contentType: row.contentType,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      alt: row.alt,
      sortOrder: row.sortOrder,
    };
  }
}
