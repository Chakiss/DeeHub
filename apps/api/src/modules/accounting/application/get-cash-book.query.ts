import { Inject, Injectable } from '@nestjs/common';
import { errors, type IsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import { ACCOUNTING_REPOSITORY, type AccountingRepository } from '../domain/accounting.repository';
import { buildCashBook, type CashBook } from '../domain/cash-book';

/**
 * รายงานเงินสดรับ-จ่าย for a window.
 *
 * The book an individual taxpayer with เงินได้ตามมาตรา 40(8) is required to
 * keep, and the main supporting record behind ภ.ง.ด.90/94. For a property that
 * is not VAT registered it is very nearly the whole of what the Revenue
 * Department wants to see, which is why it ships in phase 1 rather than with
 * the tax documents.
 */
@Injectable()
export class GetCashBookQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
  ) {}

  async execute(propertyId: string, from: IsoDate, to: IsoDate): Promise<CashBook> {
    const property = await this.propertyRepo.findProperty(this.db, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const [movements, opening] = await Promise.all([
      this.repo.cashMovements(this.db, propertyId, from, to),
      // Without this the closing balance of a book starting mid-year matches no
      // bank account anyone can point at.
      this.repo.cashBalanceBefore(this.db, propertyId, from),
    ]);

    return buildCashBook(movements, property.currency, from, to, opening);
  }
}
