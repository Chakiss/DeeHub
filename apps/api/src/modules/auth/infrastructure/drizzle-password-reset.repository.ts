import { Injectable } from '@nestjs/common';
import { and, eq, gte, isNull, lt, ne } from 'drizzle-orm';
import { passwordResetTokens } from '../../../database/schema';
import type { Executor } from '../../../database/executor';
import type { PasswordResetRepository, StoredResetToken } from '../domain/password-reset';

@Injectable()
export class DrizzlePasswordResetRepository implements PasswordResetRepository {
  async insertToken(
    tx: Executor,
    token: {
      id: string;
      organizationId: string;
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      requestedIp: string | null;
    },
  ): Promise<void> {
    await tx.insert(passwordResetTokens).values(token);
  }

  async findByHash(tx: Executor, tokenHash: string): Promise<StoredResetToken | null> {
    const rows = await tx
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        organizationId: passwordResetTokens.organizationId,
        expiresAt: passwordResetTokens.expiresAt,
        consumedAt: passwordResetTokens.consumedAt,
        invalidatedAt: passwordResetTokens.invalidatedAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    return rows[0] ?? null;
  }

  /**
   * Conditional update, not read-then-write.
   *
   * Two requests carrying the same link can arrive together — a mail client
   * that prefetches links, a double-click. The `IS NULL` in the WHERE makes the
   * database decide which one wins; whoever gets `rowCount` 0 is the loser and
   * must not go on to set a password.
   */
  async consume(tx: Executor, tokenId: string, at: Date): Promise<boolean> {
    const result = await tx
      .update(passwordResetTokens)
      .set({ consumedAt: at })
      .where(
        and(
          eq(passwordResetTokens.id, tokenId),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  async invalidateLiveForUser(
    tx: Executor,
    userId: string,
    at: Date,
    exceptId?: string,
  ): Promise<number> {
    const conditions = [
      eq(passwordResetTokens.userId, userId),
      isNull(passwordResetTokens.consumedAt),
      isNull(passwordResetTokens.invalidatedAt),
    ];

    const result = await tx
      .update(passwordResetTokens)
      .set({ invalidatedAt: at })
      .where(
        exceptId ? and(...conditions, ne(passwordResetTokens.id, exceptId)) : and(...conditions),
      );
    return result.rowCount ?? 0;
  }

  async countRecentRequests(tx: Executor, userId: string, since: Date): Promise<number> {
    const rows = await tx
      .select({ id: passwordResetTokens.id })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          gte(passwordResetTokens.createdAt, since),
          // A token the person already used does not count against them: they
          // completed the flow, and a second genuine request afterwards is a
          // second genuine request.
          isNull(passwordResetTokens.consumedAt),
        ),
      );
    return rows.length;
  }

  async deleteOlderThan(tx: Executor, cutoff: Date): Promise<number> {
    const result = await tx
      .delete(passwordResetTokens)
      .where(lt(passwordResetTokens.createdAt, cutoff));
    return result.rowCount ?? 0;
  }
}
