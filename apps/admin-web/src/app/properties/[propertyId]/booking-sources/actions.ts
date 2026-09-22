'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type BookingSource } from '@/lib/api';

export interface BookingSourceResult {
  readonly ok: boolean;
  readonly source?: BookingSource;
  readonly sources?: BookingSource[];
  readonly error?: { code: string; message: string };
}

function failure(error: unknown): BookingSourceResult {
  if (error instanceof ApiError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  throw error;
}

/** The list, and the booking form that offers it. */
function revalidate(propertyId: string): void {
  revalidatePath(`/properties/${propertyId}/booking-sources`);
  revalidatePath(`/properties/${propertyId}/reservations/new`);
}

export async function createBookingSource(
  propertyId: string,
  input: { name: string; kind: 'OTA' | 'TRAVEL_AGENT' },
): Promise<BookingSourceResult> {
  try {
    const source = await api.createBookingSource(propertyId, input);
    revalidate(propertyId);
    return { ok: true, source };
  } catch (error) {
    return failure(error);
  }
}

export async function updateBookingSource(
  propertyId: string,
  sourceId: string,
  input: { name?: string; isActive?: boolean },
): Promise<BookingSourceResult> {
  try {
    const source = await api.updateBookingSource(propertyId, sourceId, input);
    revalidate(propertyId);
    return { ok: true, source };
  } catch (error) {
    return failure(error);
  }
}

/** Add whichever of the usual OTAs this property does not list yet. */
export async function addDefaultBookingSources(propertyId: string): Promise<BookingSourceResult> {
  try {
    const sources = await api.addDefaultBookingSources(propertyId);
    revalidate(propertyId);
    return { ok: true, sources };
  } catch (error) {
    return failure(error);
  }
}
