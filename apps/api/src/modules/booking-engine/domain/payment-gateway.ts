/**
 * Taking a card payment (roadmap Phase 3).
 *
 * A port, like the notification senders and the OTA connectors, for the same
 * reason: Omise today, Stripe or 2C2P tomorrow, and nothing above this knows
 * which. Every provider's auth scheme, payload shape and quirks stay behind it.
 *
 * **The card never touches this system.** The browser tokenises it against the
 * provider directly and sends us a one-time token; we charge the token. That is
 * not a nicety — a server that receives a PAN is in PCI DSS scope, which for a
 * three-person hotel company is a compliance programme rather than a feature.
 */

export interface ChargeRequest {
  /** One-time token from the provider's client library. Never a card number. */
  readonly token: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Shown on the guest's statement, so it has to name the hotel. */
  readonly description: string;
  /** Our booking code, for reconciling a provider dashboard against ours. */
  readonly reference: string;
}

export type ChargeOutcome =
  | { readonly status: 'PAID'; readonly providerReference: string }
  /**
   * The provider is not configured. Not a failure and not a success: nobody
   * was ever going to be charged, and telling a guest their card was declined
   * would be a lie. Same three-way shape as the notification senders.
   */
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | {
      readonly status: 'DECLINED';
      /** Safe to show a guest: "insufficient funds", not a stack trace. */
      readonly reason: string;
      /** True for a network fault rather than a refusal by the bank. */
      readonly retryable: boolean;
    };

export interface PaymentGateway {
  readonly provider: string;
  /** Whether a charge could be attempted at all. Drives what the page offers. */
  isConfigured(): boolean;
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
