import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { organizations, properties } from '../../../database/schema';
import { runWithTenant } from '../../../common/tenant/tenant-context';

export interface PublicProperty {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly country: string | null;
  readonly phone: string | null;
  readonly checkInTime: string;
  readonly checkOutTime: string;
}

/**
 * Turn a public URL into a tenant.
 *
 * Every other entry point in the system establishes tenancy from an
 * authenticated token. The booking engine has no token by definition, so the
 * tenant comes from the URL — which makes this the one place where a stranger
 * chooses which organization's data is loaded, and therefore the place to be
 * careful.
 *
 * Two things make that safe. The lookup is by the pair `(organization slug,
 * property code)` and both must match, so a guessed code alone reaches nothing.
 * And what it returns is a fixed, deliberately small set of fields — a hotel's
 * name and its check-in times — rather than the property row, so a column added
 * later does not become public by default.
 *
 * A suspended organization resolves to nothing. Its bookings would be taken by
 * a hotel that is no longer a customer.
 */
@Injectable()
export class PublicPropertyResolver {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async resolve(organizationSlug: string, propertyCode: string): Promise<PublicProperty> {
    const rows = await this.db
      .select({
        organizationId: properties.organizationId,
        propertyId: properties.id,
        name: properties.name,
        currency: properties.currency,
        timezone: properties.timezone,
        country: properties.country,
        phone: properties.phone,
        checkInTime: properties.checkInTime,
        checkOutTime: properties.checkOutTime,
      })
      .from(properties)
      .innerJoin(organizations, eq(organizations.id, properties.organizationId))
      .where(
        and(
          sql`lower(${organizations.slug}) = lower(${organizationSlug})`,
          sql`lower(${properties.code}) = lower(${propertyCode})`,
          eq(organizations.status, 'ACTIVE'),
          eq(properties.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    const property = rows[0];
    // One message for a wrong slug, a wrong code, a suspended organization and
    // a closed property. None of those distinctions are a stranger's business.
    if (!property) throw errors.notFound('Property', `${organizationSlug}/${propertyCode}`);

    return property;
  }

  /**
   * Run tenant-scoped work for a public caller.
   *
   * `userId` is null and stays null: nothing in the booking engine acts on
   * behalf of a person, and an audit entry that named one would be inventing an
   * actor.
   */
  async scoped<T>(property: PublicProperty, fn: () => Promise<T>): Promise<T> {
    return runWithTenant(
      {
        organizationId: property.organizationId,
        userId: null,
        propertyId: property.propertyId,
        // The request id set by the middleware is already in scope; passing an
        // empty string keeps the type honest without inventing a correlation.
        requestId: '',
      },
      fn,
    );
  }
}
