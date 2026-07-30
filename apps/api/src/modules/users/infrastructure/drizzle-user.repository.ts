import { Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { memberships, users } from '../../../database/schema';
import { requireOrganizationId } from '../../../common/tenant/tenant-context';
import type { Executor } from '../../../database/executor';
import type { Role } from '../../auth/domain/capabilities';
import type { CreateUserRecord, OrganizationUser, UserRepository } from '../domain/user.repository';

@Injectable()
export class DrizzleUserRepository implements UserRepository {
  async list(tx: Executor): Promise<readonly OrganizationUser[]> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      .where(eq(users.organizationId, organizationId))
      .orderBy(asc(users.email));

    return Promise.all(
      rows.map(async (row) => ({ ...row, memberships: await this.roles(tx, row.id) })),
    );
  }

  async findById(tx: Executor, userId: string): Promise<OrganizationUser | null> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({
        id: users.id,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
      })
      .from(users)
      // Organization first: a valid id from another tenant must read as absent.
      .where(and(eq(users.organizationId, organizationId), eq(users.id, userId)))
      .limit(1);

    const user = rows[0];
    if (!user) return null;
    return { ...user, memberships: await this.roles(tx, user.id) };
  }

  async insert(tx: Executor, record: CreateUserRecord): Promise<void> {
    await tx.insert(users).values(record);
  }

  async updateProfile(
    tx: Executor,
    userId: string,
    fields: { fullName?: string; status?: string },
  ): Promise<void> {
    await tx
      .update(users)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(users.organizationId, requireOrganizationId()), eq(users.id, userId)));
  }

  async setOrganizationRole(
    tx: Executor,
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<void> {
    // A partial unique index allows exactly one org-wide row per user, so this
    // is an upsert on that row rather than an insert.
    await tx
      .insert(memberships)
      .values({ id: crypto.randomUUID(), organizationId, userId, propertyId: null, role })
      .onConflictDoUpdate({
        target: memberships.userId,
        targetWhere: isNull(memberships.propertyId),
        set: { role, updatedAt: new Date() },
      });
  }

  async countOtherActiveOwners(tx: Executor, excludingUserId: string): Promise<number> {
    const organizationId = requireOrganizationId();

    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, 'OWNER'),
          // A disabled owner cannot appoint anyone, so it does not count as
          // one for the purposes of not locking the organization out.
          eq(users.status, 'ACTIVE'),
          ne(memberships.userId, excludingUserId),
        ),
      );

    return rows[0]?.count ?? 0;
  }

  private async roles(
    tx: Executor,
    userId: string,
  ): Promise<readonly { role: Role; propertyId: string | null }[]> {
    const rows = await tx
      .select({ role: memberships.role, propertyId: memberships.propertyId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, requireOrganizationId()),
          eq(memberships.userId, userId),
        ),
      );

    return rows.map((row) => ({ role: row.role as Role, propertyId: row.propertyId }));
  }
}
