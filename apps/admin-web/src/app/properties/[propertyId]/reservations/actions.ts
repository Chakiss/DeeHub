'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type ModifiedStay, type ModifyStayInput } from '@/lib/api';

export interface ReservationActionResult {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
}

function failure(error: unknown): ReservationActionResult {
  if (error instanceof ApiError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  // Anything that is not a modelled API error is a bug, and swallowing it here
  // would hide it from Error Reporting behind a polite red box.
  throw error;
}

/**
 * A status change moves inventory, so every screen that reads availability is
 * stale the moment one succeeds — not only the page the button was on.
 */
function revalidate(propertyId: string, reservationId: string): void {
  revalidatePath(`/properties/${propertyId}/reservations/${reservationId}`);
  revalidatePath(`/properties/${propertyId}/reservations`);
  revalidatePath(`/properties/${propertyId}/stay-view`);
  revalidatePath(`/properties/${propertyId}/inventory`);
}

/**
 * Cancel, releasing the nights that have not been consumed.
 *
 * `version` is the one the page rendered. If someone else has touched this
 * booking since, the API refuses with a conflict rather than overwriting them —
 * which is the entire point of showing a stale-data error instead of retrying.
 */
export async function cancelReservation(
  propertyId: string,
  reservationId: string,
  version: number,
  reason?: string,
): Promise<ReservationActionResult> {
  try {
    await api.cancelReservation(propertyId, reservationId, version, reason);
    revalidate(propertyId, reservationId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Check in. The API refuses unless every room is assigned and arrival is due. */
export async function checkInReservation(
  propertyId: string,
  reservationId: string,
  version: number,
): Promise<ReservationActionResult> {
  try {
    await api.checkIn(propertyId, reservationId, version);
    revalidate(propertyId, reservationId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Check out, which also hands the rooms to housekeeping as DIRTY. */
export async function checkOutReservation(
  propertyId: string,
  reservationId: string,
  version: number,
): Promise<ReservationActionResult> {
  try {
    await api.checkOut(propertyId, reservationId, version);
    revalidate(propertyId, reservationId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
export interface ModifyStayActionResult extends ReservationActionResult {
  readonly modified?: ModifiedStay;
}

/**
 * Change one stay's dates, room type or occupancy.
 *
 * The API releases the old nights and takes the new ones in a single
 * transaction, so a refusal here means the booking is untouched — never half
 * moved. `version` guards against a second clerk editing the same booking.
 */
export async function modifyStay(
  propertyId: string,
  reservationId: string,
  stayId: string,
  input: ModifyStayInput,
): Promise<ModifyStayActionResult> {
  try {
    const modified = await api.modifyStay(propertyId, reservationId, stayId, input);
    revalidate(propertyId, reservationId);
    return { ok: true, modified };
  } catch (error) {
    return failure(error);
  }
}
