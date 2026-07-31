import type { NotificationChannel } from './notification';

/** One message, already rendered. Senders never render. */
export interface OutgoingMessage {
  readonly recipient: string;
  readonly subject: string | null;
  readonly body: string;
}

/**
 * What happened to one send attempt.
 *
 * SKIPPED is not a failure and not a success: it is "nobody was ever going to
 * receive this", which is a different thing to tell an operator than "the
 * provider refused it". A deployment with no email provider configured
 * produces SKIPPED, and the message body is still stored so the hotel can see
 * exactly what a guest would have been told.
 */
export type SendOutcome =
  | { readonly status: 'SENT' }
  | { readonly status: 'SKIPPED'; readonly reason: string }
  | { readonly status: 'FAILED'; readonly error: string; readonly retryable: boolean };

/**
 * Delivery port (Adapter Pattern, CLAUDE.md).
 *
 * Every channel implements this and nothing above it knows which provider is
 * behind it — the same rule the OTA connectors follow, for the same reason:
 * swapping a provider must not touch a use case.
 */
export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(message: OutgoingMessage): Promise<SendOutcome>;
}

export const NOTIFICATION_SENDERS = Symbol('NOTIFICATION_SENDERS');
