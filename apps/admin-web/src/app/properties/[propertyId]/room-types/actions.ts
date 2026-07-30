'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiError,
  api,
  type CreateRoomTypeInput,
  type RoomType,
  type UpdateRoomTypeInput,
} from '@/lib/api';

export interface RoomTypeResult {
  readonly ok: boolean;
  readonly roomType?: RoomType;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

function failure(error: unknown): RoomTypeResult {
  if (error instanceof ApiError) {
    // Passed through with its code so the form can point at the right field —
    // CONFLICT means the code is taken, VALIDATION_ERROR means the occupancy
    // numbers contradict each other. A generic "failed" would make the user
    // guess which.
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  throw error;
}

/** Both pages: the grid's rows come from the same room types. */
function revalidate(propertyId: string): void {
  revalidatePath(`/properties/${propertyId}/room-types`);
  revalidatePath(`/properties/${propertyId}/inventory`);
}

export async function createRoomType(
  propertyId: string,
  input: CreateRoomTypeInput,
): Promise<RoomTypeResult> {
  try {
    const roomType = await api.createRoomType(propertyId, input);
    revalidate(propertyId);
    return { ok: true, roomType };
  } catch (error) {
    return failure(error);
  }
}

export async function updateRoomType(
  propertyId: string,
  roomTypeId: string,
  input: UpdateRoomTypeInput,
): Promise<RoomTypeResult> {
  try {
    const roomType = await api.updateRoomType(propertyId, roomTypeId, input);
    revalidate(propertyId);
    return { ok: true, roomType };
  } catch (error) {
    return failure(error);
  }
}
