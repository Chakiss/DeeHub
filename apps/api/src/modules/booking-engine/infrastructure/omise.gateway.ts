import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../../config/env';
import type {
  ChargeState,
  PaymentGateway,
  PaymentMethod,
  StartChargeOutcome,
  StartChargeRequest,
} from '../domain/payment-gateway';

/** Long enough for a bank, short enough not to hold a guest on a spinner. */
const TIMEOUT_MS = 20_000;
const API = 'https://api.omise.co';

interface OmiseCharge {
  id?: string;
  object?: string;
  status?: 'successful' | 'pending' | 'failed' | 'expired' | 'reversed' | string;
  paid?: boolean;
  authorize_uri?: string | null;
  expires_at?: string | null;
  failure_message?: string | null;
  failure_code?: string | null;
  message?: string;
  code?: string;
  source?: { scannable_code?: { image?: { download_uri?: string } } } | null;
}

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
 *
 * Two wire shapes, one port:
 * - CARD: `POST /charges` with the token. Omise answers `successful` at
 *   once, or `pending` with an `authorize_uri` when the bank wants 3-D
 *   Secure; the guest goes there and comes back to `return_uri`.
 * - PROMPTPAY: `POST /sources` (type promptpay) then `POST /charges` with the
 *   source; the charge is `pending` and carries a QR image until the guest's
 *   bank app pays it or it expires.
 */
@Injectable()
export class OmiseGateway implements PaymentGateway {
  readonly provider = 'omise';
  private readonly logger = new Logger(OmiseGateway.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  isConfigured(): boolean {
    return Boolean(this.env.OMISE_SECRET_KEY);
  }

  methods(): readonly PaymentMethod[] {
    return this.isConfigured() ? ['CARD', 'PROMPTPAY'] : [];
  }

  async startCharge(request: StartChargeRequest): Promise<StartChargeOutcome> {
    const key = this.env.OMISE_SECRET_KEY;
    if (!key) {
      return {
        status: 'UNAVAILABLE',
        reason: 'No payment provider configured (set OMISE_SECRET_KEY)',
      };
    }

    try {
      const params = new URLSearchParams({
        amount: String(request.amountMinor),
        currency: request.currency.toLowerCase(),
        description: request.description,
        return_uri: request.returnUri,
        // Omise echoes metadata into its dashboard, which is where somebody
        // reconciles a settlement against our bookings.
        'metadata[reference]': request.reference,
      });

      if (request.method === 'CARD') {
        if (!request.token) {
          return { status: 'DECLINED', reason: 'No card token was given', retryable: false };
        }
        params.set('card', request.token);
      } else {
        const source = await this.post<OmiseCharge>(key, '/sources', {
          type: 'promptpay',
          amount: String(request.amountMinor),
          currency: request.currency.toLowerCase(),
        });
        if (!source.ok || !source.body.id) {
          return {
            status: 'DECLINED',
            reason: (source.body.message ?? 'PromptPay is not available right now').slice(0, 200),
            retryable: source.status >= 500,
          };
        }
        params.set('source', source.body.id);
      }

      const charge = await this.post<OmiseCharge>(key, '/charges', params);
      return this.outcomeOf(charge.status, charge.body);
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

  async fetchCharge(providerReference: string): Promise<ChargeState> {
    const key = this.env.OMISE_SECRET_KEY;
    if (!key) throw new Error('No payment provider configured (set OMISE_SECRET_KEY)');

    const response = await fetch(`${API}/charges/${encodeURIComponent(providerReference)}`, {
      headers: { Authorization: basic(key) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as OmiseCharge;
    if (!response.ok) {
      throw new Error(`Omise answered ${String(response.status)} for ${providerReference}`);
    }
    return stateOf(body);
  }

  private async post<T>(
    key: string,
    path: string,
    params: URLSearchParams | Record<string, string>,
  ): Promise<{ ok: boolean; status: number; body: T }> {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        // HTTP Basic with the secret as the username, per Omise's API.
        Authorization: basic(key),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params instanceof URLSearchParams ? params : new URLSearchParams(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as T;
    return { ok: response.ok, status: response.status, body };
  }

  private outcomeOf(httpStatus: number, body: OmiseCharge): StartChargeOutcome {
    if (httpStatus >= 200 && httpStatus < 300 && body.id) {
      if (body.paid === true || body.status === 'successful') {
        return { status: 'PAID', providerReference: body.id };
      }
      if (body.status === 'pending') {
        return {
          status: 'PENDING',
          providerReference: body.id,
          authorizeUri: body.authorize_uri ?? null,
          qrImageUri: body.source?.scannable_code?.image?.download_uri ?? null,
          expiresAt: body.expires_at ? new Date(body.expires_at) : null,
        };
      }
    }
    /*
     * A charge that is accepted but not `paid` is a DECLINE, not an error:
     * Omise answers 200 with `paid: false` and a failure message when the
     * bank refuses. Treating the HTTP status alone as the outcome would
     * record an unpaid booking as settled.
     */
    const reason = body.failure_message ?? body.message ?? `Omise responded ${String(httpStatus)}`;
    return {
      status: 'DECLINED',
      reason: reason.slice(0, 200),
      // 5xx is theirs and worth retrying; a refusal by the bank is not.
      retryable: httpStatus >= 500,
    };
  }
}

function basic(key: string): string {
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

function stateOf(body: OmiseCharge): ChargeState {
  if (body.paid === true || body.status === 'successful') return { status: 'PAID' };
  if (body.status === 'pending') return { status: 'PENDING' };
  if (body.status === 'expired') return { status: 'EXPIRED' };
  return {
    status: 'FAILED',
    reason: (body.failure_message ?? body.status ?? 'The payment did not go through').slice(0, 200),
  };
}
