import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { memberships, organizations, refreshTokens, users } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import type {
  AuthRepository,
  AuthUser,
  StoredRefreshToken,
  UserPrincipal,
} from '../domain/auth.repository';
import type { Role } from '../domain/capabilities';

@Injectable()
export class DrizzleAuthRepository implements AuthRepository {
  async findUserForLogin(tx: Executor, orgSlug: string, email: string): Promise<AuthUser | null> {
    // Email is unique per organization, so the slug is part of the identity.
    const rows = await tx
      .select({
        id: users.id,
        organizationId: users.organizationId,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(
          sql`lower(${organizations.slug}) = lower(${orgSlug})`,
          sql`lower(${users.email}) = lower(${email})`,
          // A suspended organization denies all access, regardless of user state.
          eq(organizations.status, 'ACTIVE'),
        ),
      )
      .limit(1);

    return rows[0] ?? null;
  }

  async findPrincipalById(tx: Executor, userId: string): Promise<UserPrincipal | null> {
    const rows = await tx
      .select({
        id: users.id,
        organizationId: users.organizationId,
        email: users.email,
        fullName: users.fullName,
        status: users.status,
      })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(
        and(eq(users.id, userId), eq(users.status, 'ACTIVE'), eq(organizations.status, 'ACTIVE')),
      )
      .limit(1);

    const user = rows[0];
    if (!user) return null;

    return {
      id: user.id,
      organizationId: user.organizationId,
      email: user.email,
      fullName: user.fullName,
      memberships: await this.findMemberships(tx, userId),
    };
  }

  async findMemberships(
    tx: Executor,
    userId: string,
  ): Promise<readonly { role: Role; propertyId: string | null }[]> {
    const rows = await tx
      .select({ role: memberships.role, propertyId: memberships.propertyId })
      .from(memberships)
      .where(eq(memberships.userId, userId));

    return rows.map((row) => ({ role: row.role as Role, propertyId: row.propertyId }));
  }

  async updatePasswordHash(tx: Executor, userId: string, passwordHash: string): Promise<void> {
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  }

  async recordLogin(tx: Executor, userId: string, at: Date): Promise<void> {
    await tx.update(users).set({ lastLoginAt: at }).where(eq(users.id, userId));
  }

  async insertRefreshToken(
    tx: Executor,
    token: {
      id: string;
      organizationId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent: string | null;
      ip: string | null;
    },
  ): Promise<void> {
    await tx.insert(refreshTokens).values(token);
  }

  async findRefreshTokenByHash(
    tx: Executor,
    tokenHash: string,
  ): Promise<StoredRefreshToken | null> {
    const rows = await tx
      .select({
        id: refreshTokens.id,
        userId: refreshTokens.userId,
        organizationId: refreshTokens.organizationId,
        expiresAt: refreshTokens.expiresAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    return rows[0] ?? null;
  }

  async rotateRefreshToken(tx: Executor, tokenId: string, replacedById: string): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedById })
      .where(eq(refreshTokens.id, tokenId));
  }

  async revokeRefreshToken(tx: Executor, tokenId: string): Promise<void> {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, tokenId));
  }

  async revokeAllForUser(tx: Executor, userId: string): Promise<number> {
    const result = await tx
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    return result.rowCount ?? 0;
  }
}
