import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import type { ChargeOutcome, ChargeRequest, PaymentGateway } from '../domain/payment-gateway';

/** Long enough for a bank, short enough not to hold a guest on a spinner. */
const TIMEOUT_MS = 20_000;

/**
 * Omise, because this is a Thailand-first product (ADR-0003).
 *
 * Omise settles in THB, supports PromptPay and Thai domestic cards that Stripe
 * does not, and is what a Bangkok hotel's accountant already recognises.
 * Stripe would be another adapter behind the same port, not a rewrite.
 *
 * With no `OMISE_SECRET_KEY` configured every charge is UNAVAILABLE with the
 * reason, and the booking is still taken — held as PENDING for the hotel to
 * confirm, which is how most small Thai hotels work today anyway. That is the
 * same call as Resend and Sentry: build the thing, leave the account to the
 * operator, and make the gap visible rather than invisible.
 */
@Injectable()
export class OmiseGateway implements PaymentGateway {
  readonly provider = 'omise';
  private readonly logger = new Logger(OmiseGateway.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  isConfigured(): boolean {
    return Boolean(this.env.OMISE_SECRET_KEY);
  }

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    const key = this.env.OMISE_SECRET_KEY;
    if (!key) {
      return {
        status: 'UNAVAILABLE',
        reason: 'No payment provider configured (set OMISE_SECRET_KEY)',
      };
    }

    try {
      const response = await fetch('https://api.omise.co/charges', {
        method: 'POST',
        headers: {
          // HTTP Basic with the secret as the username, per Omise's API.
          Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          amount: String(request.amountMinor),
          currency: request.currency.toLowerCase(),
          card: request.token,
          description: request.description,
          // Omise echoes metadata into its dashboard, which is where somebody
          // reconciles a settlement against our bookings.
          'metadata[reference]': request.reference,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        paid?: boolean;
        failure_message?: string;
        message?: string;
      };

      if (response.ok && body.paid === true && body.id) {
        return { status: 'PAID', providerReference: body.id };
      }

      /*
       * A charge that is accepted but not `paid` is a DECLINE, not an error:
       * Omise answers 200 with `paid: false` and a failure message when the
       * bank refuses. Treating the HTTP status alone as the outcome would
       * record an unpaid booking as settled.
       */
      const reason =
        body.failure_message ?? body.message ?? `Omise responded ${String(response.status)}`;
      return {
        status: 'DECLINED',
        reason: reason.slice(0, 200),
        // 5xx is theirs and worth retrying; a refusal by the bank is not.
        retryable: response.status >= 500,
      };
    } catch (error) {
      this.logger.warn(`Omise charge failed: ${String(error)}`);
      return {
        status: 'DECLINED',
        // Deliberately vague to the guest, specific in the log: a timeout is
        // not something they can act on, and the raw error is not theirs.
        reason: 'The payment could not be completed. Please try again.',
        retryable: true,
      };
    }
  }
}
