import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import type { NotificationChannel } from '../domain/notification';
import type {
  NotificationSender,
  OutgoingMessage,
  SendOutcome,
} from '../domain/notification-sender';

const TIMEOUT_MS = 10_000;
/** LINE rejects anything longer; better to trim than to have the push refused. */
const MAX_TEXT = 4_900;

/**
 * LINE push, for STAFF alerts only.
 *
 * Not for guests, and that is a limitation of LINE rather than a choice: a
 * push needs the recipient's LINE user id, which only exists once that person
 * has added the hotel's official account. A guest who booked by phone has not,
 * and DeeHub has nowhere to collect one. Staff have — one target id in
 * configuration reaches the group the desk already watches.
 *
 * The subject is folded into the body. LINE has no such field, and dropping it
 * would lose the one line that says what the message is about.
 */
@Injectable()
export class LineMessagingSender implements NotificationSender {
  readonly channel: NotificationChannel = 'LINE';
  private readonly logger = new Logger(LineMessagingSender.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    if (!this.env.LINE_CHANNEL_TOKEN) {
      return {
        status: 'SKIPPED',
        reason: 'No LINE channel configured (set LINE_CHANNEL_TOKEN)',
      };
    }

    const text = [message.subject, message.body].filter(Boolean).join('\n\n').slice(0, MAX_TEXT);

    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.LINE_CHANNEL_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: message.recipient, messages: [{ type: 'text', text }] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (response.ok) return { status: 'SENT' };

      const detail = (await response.text()).slice(0, 500);
      // Same split as email: 4xx is the request being wrong, 429 is "not now".
      const retryable = response.status >= 500 || response.status === 429;
      return {
        status: 'FAILED',
        error: `LINE responded ${String(response.status)}: ${detail}`,
        retryable,
      };
    } catch (error) {
      this.logger.warn(`LINE push failed: ${String(error)}`);
      return { status: 'FAILED', error: String(error).slice(0, 500), retryable: true };
    }
  }
}
