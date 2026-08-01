import { Module } from '@nestjs/common';
import { PropertiesModule } from '../properties/properties.module';
import { GetFolioQuery } from './application/get-folio.query';
import { PostChargeUseCase } from './application/post-charge.usecase';
import { RecordPaymentUseCase } from './application/record-payment.usecase';
import { VoidFolioLineUseCase } from './application/void-folio-line.usecase';
import { FOLIO_REPOSITORY } from './domain/folio.repository';
import { DrizzleFolioRepository } from './infrastructure/drizzle-folio.repository';
import { FolioController } from './interface/folio.controller';

/**
 * The guest's account.
 *
 * Owns extra charges and payments, and nothing else — room charges are read
 * from the reservation rather than copied, so this module has no opinion about
 * what a night costs and cannot disagree with the booking.
 *
 * `GetFolioQuery` is exported because check-out needs the outstanding balance:
 * letting a guest walk out is the last moment anybody can ask for money.
 */
@Module({
  imports: [PropertiesModule],
  controllers: [FolioController],
  providers: [
    { provide: FOLIO_REPOSITORY, useClass: DrizzleFolioRepository },
    GetFolioQuery,
    PostChargeUseCase,
    RecordPaymentUseCase,
    VoidFolioLineUseCase,
  ],
  exports: [GetFolioQuery, FOLIO_REPOSITORY],
})
export class FolioModule {}
