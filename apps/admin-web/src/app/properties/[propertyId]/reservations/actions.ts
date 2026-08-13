'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiError,
  api,
  type CreateReservationInput,
  type CreatedReservation,
  type ExtendedStay,
  type ExtendStayInput,
  type InventoryGrid,
  type ModifiedStay,
  type ModifyStayInput,
  type Folio,
  type ShortenedStay,
  type ShortenStayInput,
} from '@/lib/api';
import type { FolioChargeKind, FolioPaymentKind, FolioPaymentMethod } from '@/lib/folio-types';

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

/**
 * Check out, which also hands the rooms to housekeeping as DIRTY.
 *
 * `releaseRemainingNights` puts tonight back on sale for a guest who left
 * before using it. The booking is untouched and the guest stays charged; only
 * the room returns to the market. Defaulted off here as well as in the API, so
 * the ordinary departure cannot become the unusual one by accident.
 */
export async function checkOutReservation(
  propertyId: string,
  reservationId: string,
  version: number,
  releaseRemainingNights = false,
): Promise<ReservationActionResult> {
  try {
    await api.checkOut(propertyId, reservationId, version, releaseRemainingNights);
    revalidate(propertyId, reservationId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export interface CreateReservationResult extends ReservationActionResult {
  readonly reservation?: CreatedReservation;
}

/**
 * Take a booking at the desk.
 *
 * The API is the only authority on whether the nights are sellable — it checks
 * and decrements allotment inside the same transaction that writes the booking,
 * so two clerks selling the last room cannot both succeed. The availability
 * shown on the form is advisory and can be stale by the time Save is pressed;
 * a refusal here is the correct outcome, not a bug to work around.
 */
export async function createReservation(
  propertyId: string,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  try {
    const reservation = await api.createReservation(propertyId, input);
    revalidatePath(`/properties/${propertyId}/reservations`);
    revalidatePath(`/properties/${propertyId}/stay-view`);
    revalidatePath(`/properties/${propertyId}/inventory`);
    return { ok: true, reservation };
  } catch (error) {
    return failure(error);
  }
}

export interface AvailabilityResult extends ReservationActionResult {
  readonly grid?: InventoryGrid;
}

/**
 * What is sellable over a date window, for the form to show before submitting.
 *
 * A read, deliberately: it takes no hold. Showing "2 left" and then refusing
 * the booking is honest; pretending to reserve one while the clerk types the
 * guest's name would leak inventory every time a form is abandoned.
 */
export async function checkAvailability(
  propertyId: string,
  from: string,
  to: string,
): Promise<AvailabilityResult> {
  try {
    return { ok: true, grid: await api.inventoryGrid(propertyId, from, to) };
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

export interface ExtendStayActionResult extends ReservationActionResult {
  readonly extended?: ExtendedStay;
}

export interface ShortenStayActionResult extends ReservationActionResult {
  readonly shortened?: ShortenedStay;
}

/**
 * Keep a guest longer by adding nights to the end of a stay.
 *
 * Separate from `modifyStay` because the API treats them as different
 * operations: modifying gives the old nights back before taking new ones and is
 * refused once a night has been slept in, while this only ever adds. It is the
 * only way to change a booking whose guest is already in the building.
 */
export async function extendStay(
  propertyId: string,
  reservationId: string,
  stayId: string,
  input: ExtendStayInput,
): Promise<ExtendStayActionResult> {
  try {
    const extended = await api.extendStay(propertyId, reservationId, stayId, input);
    revalidate(propertyId, reservationId);
    return { ok: true, extended };
  } catch (error) {
    return failure(error);
  }
}

/**
 * A guest leaves early: drop nights from the end of a stay.
 *
 * The mirror of `extendStay`, and the other half of the only change a stay in
 * progress accepts. It releases the dropped nights back into inventory and
 * takes them off the bill — with no early-departure fee, because there is no
 * folio for one to land on yet.
 */
export async function shortenStay(
  propertyId: string,
  reservationId: string,
  stayId: string,
  input: ShortenStayInput,
): Promise<ShortenStayActionResult> {
  try {
    const shortened = await api.shortenStay(propertyId, reservationId, stayId, input);
    revalidate(propertyId, reservationId);
    return { ok: true, shortened };
  } catch (error) {
    return failure(error);
  }
}

export interface FolioActionResult extends ReservationActionResult {
  readonly folio?: Folio;
}

/**
 * Every folio write returns the WHOLE account, not just the line it added.
 *
 * The balance is what the person is looking at, and it changes with each line —
 * so returning the new total is the difference between a screen that is correct
 * and one that needs a refresh nobody remembers to do.
 */
export async function postFolioCharge(
  propertyId: string,
  reservationId: string,
  input: { kind: FolioChargeKind; amount: number; description?: string; taxable?: boolean },
): Promise<FolioActionResult> {
  try {
    const folio = await api.postFolioCharge(propertyId, reservationId, input);
    revalidate(propertyId, reservationId);
    return { ok: true, folio };
  } catch (error) {
    return failure(error);
  }
}

export async function recordFolioPayment(
  propertyId: string,
  reservationId: string,
  input: {
    kind?: FolioPaymentKind;
    method: FolioPaymentMethod;
    amount: number;
    reference?: string;
  },
): Promise<FolioActionResult> {
  try {
    const folio = await api.recordFolioPayment(propertyId, reservationId, input);
    revalidate(propertyId, reservationId);
    return { ok: true, folio };
  } catch (error) {
    return failure(error);
  }
}

export async function voidFolioLine(
  propertyId: string,
  reservationId: string,
  line: { kind: 'CHARGE' | 'PAYMENT'; id: string },
  reason: string,
): Promise<FolioActionResult> {
  try {
    const folio = await api.voidFolioLine(propertyId, reservationId, line, reason);
    revalidate(propertyId, reservationId);
    return { ok: true, folio };
  } catch (error) {
    return failure(error);
  }
}
