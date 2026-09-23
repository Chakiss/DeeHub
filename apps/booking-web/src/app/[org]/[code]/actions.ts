'use server';

import { redirect } from 'next/navigation';
import {
  api,
  ApiError,
  type PaymentMethod,
  type PaymentStatus,
  type StartPaymentResult,
} from '@/lib/api';

export interface BookingFormState {
  readonly error?: 'failed' | 'tooMany' | 'unavailable' | 'invalid';
}

/**
 * Hold the room. On success the guest is sent to the payment page; on
 * failure the form re-renders with one of a few reasons a guest can act on.
 * The price is never in the form: the API prices the booking itself.
 */
export async function createBooking(
  _previous: BookingFormState,
  formData: FormData,
): Promise<BookingFormState> {
  const org = String(formData.get('org') ?? '');
  const code = String(formData.get('code') ?? '');
  const email = String(formData.get('email') ?? '').trim();
  const name = String(formData.get('name') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').trim();
  const requests = String(formData.get('specialRequests') ?? '').trim();
  const adults = Number(formData.get('adults'));
  const children = Number(formData.get('children'));

  if (!org || !code || !email || !name || !Number.isInteger(adults)) return { error: 'invalid' };

  let bookingCode: string;
  try {
    const created = await api.createBooking(org, code, {
      guest: { name, email, ...(phone ? { phone } : {}) },
      checkIn: String(formData.get('checkIn') ?? ''),
      checkOut: String(formData.get('checkOut') ?? ''),
      stays: [
        {
          roomTypeId: String(formData.get('roomTypeId') ?? ''),
          ratePlanId: String(formData.get('ratePlanId') ?? ''),
          adults,
          children: Number.isInteger(children) ? children : 0,
        },
      ],
      ...(requests ? { specialRequests: requests } : {}),
    });
    bookingCode = created.code;
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'RATE_LIMITED') return { error: 'tooMany' };
      if (
        error.status === 409 ||
        error.code === 'INVENTORY_UNAVAILABLE' ||
        error.code === 'RESTRICTION_VIOLATED'
      ) {
        return { error: 'unavailable' };
      }
      if (error.status === 422) return { error: 'invalid' };
      return { error: 'failed' };
    }
    throw error;
  }

  redirect(`/${org}/${code}/pay/${bookingCode}?email=${encodeURIComponent(email)}`);
}

export async function startPayment(input: {
  org: string;
  code: string;
  bookingCode: string;
  method: PaymentMethod;
  token?: string;
  returnUri: string;
}): Promise<StartPaymentResult | { status: 'ERROR'; message: string }> {
  try {
    return await api.startPayment(input.org, input.code, input.bookingCode, {
      method: input.method,
      ...(input.token ? { token: input.token } : {}),
      returnUri: input.returnUri,
    });
  } catch (error) {
    if (error instanceof ApiError) return { status: 'ERROR', message: error.message };
    throw error;
  }
}

export async function pollPayment(input: {
  org: string;
  code: string;
  bookingCode: string;
  intentId: string;
  email: string;
}): Promise<PaymentStatus | { outcome: 'ERROR'; message: string }> {
  try {
    return await api.paymentStatus(
      input.org,
      input.code,
      input.bookingCode,
      input.intentId,
      input.email,
    );
  } catch (error) {
    if (error instanceof ApiError) return { outcome: 'ERROR', message: error.message };
    throw error;
  }
}
