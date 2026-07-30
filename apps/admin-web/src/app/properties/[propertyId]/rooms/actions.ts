'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type Room } from '@/lib/api';

export interface RoomResult {
  readonly ok: boolean;
  readonly room?: Room;
  readonly error?: { code: string; message: string };
}

export interface AssignResult {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    return { ok: false as const, error: { code: error.code, message: error.message } };
  }
  throw error;
}

/** Both screens read the same rooms, and the stay view reads assignments. */
function revalidate(propertyId: string): void {
  revalidatePath(`/properties/${propertyId}/rooms`);
  revalidatePath(`/properties/${propertyId}/stay-view`);
}

export async function createRoom(
  propertyId: string,
  input: { roomTypeId: string; roomNumber: string; floor?: string | null },
): Promise<RoomResult> {
  try {
    const room = await api.createRoom(propertyId, input);
    revalidate(propertyId);
    return { ok: true, room };
  } catch (error) {
    return failure(error);
  }
}

export async function updateRoom(
  propertyId: string,
  roomId: string,
  input: {
    housekeepingStatus?: string;
    isActive?: boolean;
    roomNumber?: string;
    floor?: string | null;
  },
): Promise<RoomResult> {
  try {
    const room = await api.updateRoom(propertyId, roomId, input);
    revalidate(propertyId);
    return { ok: true, room };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Assign or release. A CONFLICT here means the room is already taken for
 * overlapping nights — the API refuses it at the database, and the message
 * names the dates so the front desk can act on it.
 */
/**
 * Check in. The API refuses unless every room is assigned and the booking
 * arrives today or earlier — those messages are passed through so the front
 * desk sees which condition failed.
 */
export async function checkIn(
  propertyId: string,
  reservationId: string,
  version: number,
): Promise<AssignResult> {
  try {
    await api.checkIn(propertyId, reservationId, version);
    revalidate(propertyId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Check out, which also hands the rooms to housekeeping as DIRTY. */
export async function checkOut(
  propertyId: string,
  reservationId: string,
  version: number,
): Promise<AssignResult> {
  try {
    await api.checkOut(propertyId, reservationId, version);
    revalidate(propertyId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function assignRoom(
  propertyId: string,
  stayId: string,
  roomId: string | null,
): Promise<AssignResult> {
  try {
    await api.assignRoom(propertyId, stayId, roomId);
    revalidate(propertyId);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
