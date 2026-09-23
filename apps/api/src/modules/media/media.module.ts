import { Module } from '@nestjs/common';
import { PropertiesModule } from '../properties/properties.module';
import { ManageMediaUseCase } from './application/manage-media.usecase';
import { MEDIA_REPOSITORY } from './domain/media.repository';
import { OBJECT_STORE } from './domain/object-store';
import { DrizzleMediaRepository } from './infrastructure/drizzle-media.repository';
import { S3ObjectStore } from './infrastructure/s3-object-store';
import { MediaController } from './interface/media.controller';

/**
 * Photos: rows here, bytes in an S3-compatible store the browser writes to
 * directly on a signed URL. Exports the repository and the store so the
 * public booking page can list a property's pictures and turn keys into URLs.
 */
@Module({
  imports: [PropertiesModule],
  controllers: [MediaController],
  providers: [
    { provide: MEDIA_REPOSITORY, useClass: DrizzleMediaRepository },
    { provide: OBJECT_STORE, useClass: S3ObjectStore },
    ManageMediaUseCase,
  ],
  exports: [MEDIA_REPOSITORY, OBJECT_STORE],
})
export class MediaModule {}
