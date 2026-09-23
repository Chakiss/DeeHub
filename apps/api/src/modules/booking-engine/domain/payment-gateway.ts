/**
 * Taking a payment online (roadmap Phase 3).
 *
 * A port, like the notification senders and the OTA connectors, for the same
 * reason: Omise today, Stripe or 2C2P tomorrow, and nothing above this knows
 * which. Every provider's auth scheme, payload shape and quirks stay behind it.
 *
 * **The card never touches this system.** The browser tokenises it against the
 * provider directly and sends us a one-time token; we charge the token. That is
 * not a nicety — a server that receives a PAN is in PCI DSS scope, which for a
 * three-person hotel company is a compliance programme rather than a feature.
 *
 * **A charge is started, then settled** — two calls, because two of the three
 * ways to pay finish later than the request that began them: a card the bank
 * wants to challenge (3-D Secure) and a PromptPay QR the guest has yet to
 * scan. The provider says what happened through a webhook or when asked;
 * `fetchCharge` is how it is asked, and it is the ONLY source of truth for
 * "paid" — a webhook body is a claim, not a receipt.
 */

export type PaymentMethod = 'CARD' | 'PROMPTPAY';

export interface StartChargeRequest {
  readonly method: PaymentMethod;
  /** One-time token from the provider's client library. CARD only; never a card number. */
  readonly token?: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Shown on the guest's statement, so it has to name the hotel. */
  readonly description: string;
  /** Our booking code, for reconciling a provider dashboard against ours. */
  readonly reference: string;
  /** Where the provider sends a card holder back after a 3-D Secure challenge. */
  readonly returnUri: string;
}

export type StartChargeOutcome =
  /** Done in one round trip — a card the bank did not challenge. */
  | { readonly status: 'PAID'; readonly providerReference: string }
  /**
   * Started, not finished. A card has an `authorizeUri` to send the guest
   * to; PromptPay has a `qrImageUri` to show. Either way the outcome arrives
   * later and is read with `fetchCharge`.
   */
  | {
      readonly status: 'PENDING';
      readonly providerReference: string;
      readonly authorizeUri: string | null;
      readonly qrImageUri: string | null;
      readonly expiresAt: Date | null;
    }
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

export type ChargeState =
  | { readonly status: 'PAID' }
  | { readonly status: 'PENDING' }
  | { readonly status: 'FAILED'; readonly reason: string }
  | { readonly status: 'EXPIRED' };

export interface PaymentGateway {
  readonly provider: string;
  /** Whether a charge could be attempted at all. Drives what the page offers. */
  isConfigured(): boolean;
  /** Which methods this provider (as configured) can take. */
  methods(): readonly PaymentMethod[];
  startCharge(request: StartChargeRequest): Promise<StartChargeOutcome>;
  /** Ask the provider what became of a charge. Throws on a network fault. */
  fetchCharge(providerReference: string): Promise<ChargeState>;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
