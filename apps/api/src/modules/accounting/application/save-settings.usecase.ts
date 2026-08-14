import { Inject, Injectable } from '@nestjs/common';
import { errors, isIsoDate, toIsoDate } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { AuditService, type AuditActor } from '../../../common/audit/audit.service';
import { requireTenant } from '../../../common/tenant/tenant-context';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingRepository,
  type AccountingSettingsRow,
  type SettingsPatch,
} from '../domain/accounting.repository';
import { isValidBranchCode, isValidThaiTaxId, normalizeThaiTaxId } from '../domain/tax-id';

export interface SaveSettingsInput extends Omit<SettingsPatch, 'vatRegisteredFrom'> {
  readonly propertyId: string;
  readonly vatRegisteredFrom?: string | null;
}

/**
 * Record who the hotel is to the Revenue Department.
 *
 * Everything downstream reads from here: whether VAT is charged and reclaimable,
 * which income-tax basis the reports default to, whether the provincial levy
 * applies. Getting it wrong is not a display bug — it changes the numbers.
 */
@Injectable()
export class SaveSettingsUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
    private readonly audit: AuditService,
  ) {}

  async execute(input: SaveSettingsInput, actor: AuditActor): Promise<AccountingSettingsRow> {
    const tenant = requireTenant();
    const { propertyId, ...patch } = input;

    return this.db.transaction(async (tx) => {
      const property = await this.propertyRepo.findProperty(tx, propertyId);
      if (!property) throw errors.notFound('Property', propertyId);

      const before = await this.repo.findSettings(tx, propertyId);

      const taxId = patch.taxId == null ? patch.taxId : normalizeThaiTaxId(patch.taxId);
      if (taxId != null && taxId !== '' && !isValidThaiTaxId(taxId)) {
        /*
         * Rejected at entry rather than at filing time. A wrong tax ID on the
         * hotel's own settings prints on every invoice it issues, and the first
         * anyone hears of it is a customer whose input tax has been disallowed.
         */
        throw errors.validation(
          'Tax ID must be 13 digits with a valid check digit (เลขประจำตัวผู้เสียภาษี)',
          { taxId },
        );
      }

      if (patch.branchCode != null && !isValidBranchCode(patch.branchCode)) {
        throw errors.validation('Branch code must be five digits — 00000 is the head office', {
          branchCode: patch.branchCode,
        });
      }

      const vatRegisteredFrom =
        patch.vatRegisteredFrom == null ? patch.vatRegisteredFrom : parse(patch.vatRegisteredFrom);

      // Registration without an effective date leaves every VAT report guessing
      // at the boundary month, so it is refused rather than defaulted.
      const registered = patch.vatRegistered ?? before?.vatRegistered ?? false;
      const effectiveFrom = vatRegisteredFrom ?? before?.vatRegisteredFrom ?? null;
      if (registered && effectiveFrom === null) {
        throw errors.validation(
          'A VAT-registered property needs the date registration took effect',
        );
      }

      const { vatRegisteredFrom: _raw, taxId: _rawTaxId, ...rest } = patch;
      const saved = await this.repo.upsertSettings(tx, propertyId, tenant.organizationId, {
        ...rest,
        ...(taxId === undefined ? {} : { taxId }),
        ...(vatRegisteredFrom === undefined ? {} : { vatRegisteredFrom }),
      });

      await this.audit.record(tx, {
        organizationId: tenant.organizationId,
        propertyId,
        actor,
        action: 'accounting.settings_changed',
        entityType: 'property',
        entityId: propertyId,
        before: before ? { ...before } : null,
        after: { ...saved },
      });

      return saved;
    });
  }
}

function parse(value: string) {
  if (!isIsoDate(value)) {
    throw errors.validation('vatRegisteredFrom must be a calendar date in YYYY-MM-DD form', {
      value,
    });
  }
  return toIsoDate(value);
}
