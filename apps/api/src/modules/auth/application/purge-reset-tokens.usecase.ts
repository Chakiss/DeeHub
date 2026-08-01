import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '../../../database/database.module';
import { PASSWORD_RESET_REPOSITORY, type PasswordResetRepository } from '../domain/password-reset';

/**
 * How long a spent or expired reset token is kept before it is forgotten.
 *
 * Thirty days, which is not about the token — that died within the hour — but
 * about the question "did somebody try to reset my account last week?". The
 * audit trail answers it in more detail and is kept far longer; this table is
 * the corroborating record of the tokens themselves, and a month covers the
 * window in which anyone is still investigating.
 */
const RETENTION_DAYS = 30;

/**
 * Housekeeping, run by the maintenance job.
 *
 * Not urgent and not a safety mechanism — an expired token is already refused
 * by the reset path whether or not the row exists. This only stops a table that
 * grows forever from a feature that is used a handful of times a month.
 */
@Injectable()
export class PurgeResetTokensUseCase {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly tokens: PasswordResetRepository,
  ) {}

  async execute(now: Date = new Date()): Promise<{ removed: number }> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const removed = await this.db.transaction((tx) => this.tokens.deleteOlderThan(tx, cutoff));
    return { removed };
  }
}
