import { Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE, type Database } from '../../../database/database.module';
import { ENV, type Env } from '../../../config/env';
import { newId } from '../../../common/ids';
import { AuditService } from '../../../common/audit/audit.service';
import {
  NOTIFICATION_SENDERS,
  type NotificationSender,
} from '../../notifications/domain/notification-sender';
import type { Locale } from '../../notifications/domain/templates';
import { AUTH_REPOSITORY, type AuthRepository } from '../domain/auth.repository';
import { renderPasswordResetEmail } from '../domain/password-reset-email';
import {
  PASSWORD_RESET_REPOSITORY,
  RESET_REQUEST_LIMIT,
  RESET_REQUEST_WINDOW_SECONDS,
  RESET_TOKEN_TTL_SECONDS,
  generateResetToken,
  resetLink,
  type PasswordResetRepository,
} from '../domain/password-reset';

export interface RequestPasswordResetInput {
  readonly organizationSlug: string;
  readonly email: string;
  readonly locale: Locale;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/**
 * A floor on how long this endpoint takes, in milliseconds.
 *
 * The response is identical whether or not the account exists, but the WORK is
 * not: a real account costs a token insert, a render and an HTTPS call to the
 * mail provider, and an unknown one costs a single SELECT. Left alone, the
 * difference is hundreds of milliseconds — a user-enumeration oracle that is
 * easier to read than the response body it was hidden from.
 *
 * So every request waits out the same floor. 1200 ms sits above a warm
 * provider round trip with headroom; when the real work runs longer than that
 * the difference leaks again, which is the honest limit of this technique and
 * the reason the throttle below exists as well rather than instead.
 */
const TIMING_FLOOR_MS = 1_200;

/**
 * "I cannot sign in" — the start of the only recovery path that does not need
 * a colleague (api-spec.md §3).
 *
 * Three properties matter more than anything else here.
 *
 * **It never says whether the account exists.** The caller is unauthenticated
 * and the answer is the same 202 for a real address, an unknown one, a
 * disabled account and a suspended organization. Login already takes this
 * position; an endpoint next to it that leaks the same fact would make that
 * effort pointless.
 *
 * **The link is emailed directly, not through the notifications table.** Every
 * other message the system sends is stored with its rendered body and shown on
 * the delivery-log screen to anyone holding `notification:read` — which for a
 * reset link would mean a front-desk clerk could read the owner's link out of
 * the dashboard and take the account. This one send therefore bypasses the log
 * entirely. What IS recorded is that a reset was requested, never the token.
 *
 * **A failure to send is not reported to the caller.** Telling them "we could
 * not reach that mailbox" is the same oracle in a different shape. It goes to
 * the logs, where an operator can find it.
 */
@Injectable()
export class RequestPasswordResetUseCase {
  private readonly logger = new Logger(RequestPasswordResetUseCase.name);
  private readonly email: NotificationSender | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(AUTH_REPOSITORY) private readonly auth: AuthRepository,
    @Inject(PASSWORD_RESET_REPOSITORY) private readonly tokens: PasswordResetRepository,
    @Inject(NOTIFICATION_SENDERS) senders: readonly NotificationSender[],
    private readonly audit: AuditService,
  ) {
    this.email = senders.find((sender) => sender.channel === 'EMAIL');
  }

  async execute(input: RequestPasswordResetInput): Promise<void> {
    const floor = new Promise((resolve) => setTimeout(resolve, TIMING_FLOOR_MS));
    try {
      await this.attempt(input);
    } catch (error) {
      // Never surfaced: a database or provider fault must not become the one
      // response shape that differs from all the others.
      this.logger.error(`Password reset request failed: ${String(error)}`);
    }
    await floor;
  }

  private async attempt(input: RequestPasswordResetInput): Promise<void> {
    const user = await this.auth.findUserForLogin(this.db, input.organizationSlug, input.email);

    // Unknown address, disabled account, suspended organization. An INVITED
    // user IS allowed through: they have a one-time password they may never
    // have received, and this is a reasonable way to get in.
    if (!user || user.status === 'DISABLED') return;

    const now = new Date();
    const windowStart = new Date(now.getTime() - RESET_REQUEST_WINDOW_SECONDS * 1000);
    const recent = await this.tokens.countRecentRequests(this.db, user.id, windowStart);
    if (recent >= RESET_REQUEST_LIMIT) {
      // Silently, and deliberately. The person is told the same thing either
      // way; saying "too many requests" here would confirm the account exists.
      this.logger.warn(`Password reset throttled for user ${user.id}`);
      return;
    }

    /*
     * Before minting anything: a link nobody can open is worse than no link.
     *
     * It looks like a phishing artifact, it burns one of the three requests the
     * throttle allows, and the person sits waiting for the mail that already
     * arrived. Better to send nothing and say why in the logs.
     */
    const baseUrl = this.resetBaseUrl();
    if (!baseUrl) {
      this.logger.error(
        'Password reset requested but no dashboard URL is configured. ' +
          'Set ADMIN_WEB_URL (or CORS_ORIGINS) — no link was sent.',
      );
      return;
    }

    const { token, tokenHash } = generateResetToken();
    const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_SECONDS * 1000);

    await this.db.transaction(async (tx) => {
      await this.tokens.insertToken(tx, {
        id: newId(),
        organizationId: user.organizationId,
        userId: user.id,
        tokenHash,
        expiresAt,
        requestedIp: input.ip ?? null,
      });

      await this.audit.record(tx, {
        organizationId: user.organizationId,
        propertyId: null,
        actor: {
          // Nobody is authenticated. The actor is the request, and the address
          // it named is the only identifying thing about it.
          type: 'SYSTEM',
          id: null,
          label: `password reset requested for ${user.email}`,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        },
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
        // The expiry, never the token or its hash. A hash in the audit trail
        // is still a verifier for anyone who intercepts the link.
        after: { expiresAt: expiresAt.toISOString() },
      });
    });

    const message = renderPasswordResetEmail(
      {
        fullName: user.fullName,
        organizationName: user.organizationName,
        link: resetLink(baseUrl, token),
        expiresInMinutes: Math.round(RESET_TOKEN_TTL_SECONDS / 60),
      },
      input.locale,
    );

    const outcome = (await this.email?.send({
      recipient: user.email,
      subject: message.subject,
      body: message.body,
    })) ?? { status: 'SKIPPED' as const, reason: 'No email sender registered' };

    if (outcome.status !== 'SENT') {
      /*
       * The token stays valid. It cost nothing to issue, it dies within the
       * hour, and revoking it here would only matter if the provider ACCEPTED
       * the message while reporting failure — in which case revoking is the
       * wrong move anyway, because the person is holding a live link.
       */
      const reason = outcome.status === 'SKIPPED' ? outcome.reason : outcome.error;
      this.logger.error(`Password reset email not delivered to ${user.email}: ${reason}`);
    }
  }

  /**
   * Where the link points, or null when there is nowhere sensible to point it.
   *
   * `ADMIN_WEB_URL` first, then the first allowed CORS origin, which in a
   * development checkout is the dashboard on localhost. In production a
   * loopback address is rejected instead of used: it is what an unconfigured
   * deployment falls back to, and mailing it out would send every locked-out
   * user a link to their own laptop.
   *
   * A wrong-but-plausible URL here produces a 404, not a leaked token — the
   * token is only ever accepted by this API, and the link carries it to a page
   * that posts it straight back.
   */
  private resetBaseUrl(): string | null {
    const configured = this.env.ADMIN_WEB_URL ?? this.env.CORS_ORIGINS[0] ?? null;
    if (!configured) return this.env.NODE_ENV === 'production' ? null : 'http://localhost:3000';

    if (this.env.NODE_ENV === 'production' && isLoopback(configured)) return null;
    return configured;
  }
}

/** localhost in any of the spellings a config file uses. */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    // Unparseable is not usable either.
    return true;
  }
}
