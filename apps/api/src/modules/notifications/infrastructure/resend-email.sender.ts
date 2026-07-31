import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import type { NotificationChannel } from '../domain/notification';
import type {
  NotificationSender,
  OutgoingMessage,
  SendOutcome,
} from '../domain/notification-sender';

/** Long enough for a slow provider, short enough not to stall a dispatch pass. */
const TIMEOUT_MS = 10_000;

/**
 * Email over an HTTP API (Resend), not SMTP.
 *
 * Cloud Run blocks outbound connections on the SMTP ports, so a mail server —
 * even the hotel's own — is not reachable from where this runs. An HTTPS API is
 * the only shape of email that works here, which makes this a deployment
 * constraint rather than a preference.
 *
 * With no `EMAIL_API_KEY` configured every message is SKIPPED, with the reason
 * recorded and the body kept. That is deliberate: the alternative was leaving
 * confirmations unbuilt until someone creates an account, and a hotel that can
 * SEE what each guest would have been told is in a better position than one
 * with nothing at all. Set the key and delivery starts with no code change.
 */
@Injectable()
export class ResendEmailSender implements NotificationSender {
  readonly channel: NotificationChannel = 'EMAIL';
  private readonly logger = new Logger(ResendEmailSender.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    if (!this.env.EMAIL_API_KEY || !this.env.EMAIL_FROM) {
      return {
        status: 'SKIPPED',
        reason: 'No email provider configured (set EMAIL_API_KEY and EMAIL_FROM)',
      };
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.EMAIL_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.env.EMAIL_FROM,
          to: [message.recipient],
          subject: message.subject ?? '',
          text: message.body,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.ok) return { status: 'SENT' };

      const detail = (await response.text()).slice(0, 500);
      /*
       * A 4xx is the provider saying the request itself is wrong — a malformed
       * address, an unverified sender, a revoked key. Retrying it produces the
       * same answer every time and buries the real one under attempt counts.
       * A 429 is the exception: it means "not now", not "never".
       */
      const retryable = response.status >= 500 || response.status === 429;
      return {
        status: 'FAILED',
        error: `Resend responded ${String(response.status)}: ${detail}`,
        retryable,
      };
    } catch (error) {
      // Timeouts and DNS failures are the network, not the message.
      this.logger.warn(`Email send failed: ${String(error)}`);
      return { status: 'FAILED', error: String(error).slice(0, 500), retryable: true };
    }
  }
}
