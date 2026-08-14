import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { newId } from '../../../common/ids';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import {
  PROPERTY_REPOSITORY,
  type PropertyRepository,
} from '../../properties/domain/property.repository';
import {
  ACCOUNTING_REPOSITORY,
  type AccountingRepository,
  type ExpenseCategoryRow,
} from '../domain/accounting.repository';
import { DEFAULT_EXPENSE_CATEGORIES } from '../domain/expense-category';

/**
 * Lay down the Thai hotel expense categories the first time a property needs
 * them.
 *
 * Seeded on first read rather than at property creation, for two reasons: the
 * accounting module must not reach into the property module's write path, and
 * properties created before this module existed would otherwise have no
 * categories and no way to acquire them.
 *
 * An owner facing an empty list invents their own categories, and then no two
 * months group the same way and the profit and loss cannot be compared with
 * itself. Starting from a list they edit is better than starting from nothing.
 */
@Injectable()
export class EnsureCategoriesService {
  constructor(
    @Inject(ACCOUNTING_REPOSITORY) private readonly repo: AccountingRepository,
    @Inject(PROPERTY_REPOSITORY) private readonly propertyRepo: PropertyRepository,
  ) {}

  /**
   * Categories for the property, seeding them if there are none.
   *
   * The insert is `ON CONFLICT DO NOTHING` on `(property_id, lower(code))`, so
   * two requests arriving together for a fresh property both end up with the
   * same set — the loser finds the rows already there rather than failing.
   */
  async execute(
    tx: Executor,
    propertyId: string,
    includeInactive = false,
  ): Promise<readonly ExpenseCategoryRow[]> {
    /*
     * The property has to be confirmed as ours before anything is written.
     *
     * An organization-wide membership passes `canAccessProperty` for ANY
     * property id, because it is not scoped to one — the guard's job is to
     * establish the tenant, not to check that the id in the URL belongs to it.
     * Without this lookup (which is organization-scoped, ADR-0001), a request
     * naming another tenant's property would find no categories, conclude the
     * property was new, and seed a fresh set against an id it has no business
     * touching. Reads elsewhere in this module get the same protection from
     * `findProperty`; this path is the one that writes.
     */
    const property = await this.propertyRepo.findProperty(tx, propertyId);
    if (!property) throw errors.notFound('Property', propertyId);

    const existing = await this.repo.listCategories(tx, propertyId, true);
    if (existing.length > 0) {
      return includeInactive ? existing : existing.filter((category) => category.isActive);
    }

    const organizationId = requireOrganizationId();
    await this.repo.insertCategories(
      tx,
      DEFAULT_EXPENSE_CATEGORIES.map((seed, index) => ({
        ...seed,
        id: newId(),
        organizationId,
        propertyId,
        // Seed order is the order an owner meets their own bills in, so it is
        // preserved rather than recomputed alphabetically on read.
        sortOrder: (index + 1) * 10,
        isActive: true,
      })),
    );

    return this.repo.listCategories(tx, propertyId, includeInactive);
  }
}
