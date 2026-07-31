'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiError,
  api,
  type CreateChannelInput,
  type MappingInput,
  type UpdateChannelInput,
} from '@/lib/api';

export interface ChannelActionResult {
  readonly ok: boolean;
  readonly channelId?: string;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

function failure(error: unknown): ChannelActionResult {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        // The activation refusal names the unmapped room types, and the screen
        // is far more useful when it can list them.
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  throw error;
}

function revalidate(propertyId: string, channelId?: string): void {
  revalidatePath(`/properties/${propertyId}/channels`);
  if (channelId) revalidatePath(`/properties/${propertyId}/channels/${channelId}`);
}

export async function createChannel(
  propertyId: string,
  input: CreateChannelInput,
): Promise<ChannelActionResult> {
  try {
    const created = await api.createChannel(propertyId, input);
    revalidate(propertyId, created.id);
    return { ok: true, channelId: created.id };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Rename, re-credential, or activate.
 *
 * Activation is refused by the API until every active room type is mapped —
 * an active channel with a gap does not error, it just stops pushing that
 * room type, and the OTA carries on selling stale availability.
 */
export async function updateChannel(
  propertyId: string,
  channelId: string,
  input: UpdateChannelInput,
): Promise<ChannelActionResult> {
  try {
    await api.updateChannel(propertyId, channelId, input);
    revalidate(propertyId, channelId);
    return { ok: true, channelId };
  } catch (error) {
    return failure(error);
  }
}

export async function replaceMappings(
  propertyId: string,
  channelId: string,
  roomTypes: MappingInput[],
  ratePlans: MappingInput[],
): Promise<ChannelActionResult> {
  try {
    await api.replaceChannelMappings(propertyId, channelId, { roomTypes, ratePlans });
    revalidate(propertyId, channelId);
    return { ok: true, channelId };
  } catch (error) {
    return failure(error);
  }
}
