'use server';

import { revalidatePath } from 'next/cache';
import {
  api,
  ApiError,
  type AttachMediaInput,
  type CreateMediaUploadInput,
  type MediaItem,
  type MediaUploadGrant,
  type PropertyProfile,
  type UpdateMediaInput,
  type UpdatePropertyInput,
} from '@/lib/api';

export interface ActionResult<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

function failure<T>(error: unknown): ActionResult<T> {
  if (error instanceof ApiError) {
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

/** The settings page and every page that prints the hotel's name or times. */
function revalidate(propertyId: string): void {
  revalidatePath(`/properties/${propertyId}/settings`);
  revalidatePath(`/properties/${propertyId}`, 'layout');
}

export async function saveProperty(
  propertyId: string,
  input: UpdatePropertyInput,
): Promise<ActionResult<PropertyProfile>> {
  try {
    const data = await api.updateProperty(propertyId, input);
    revalidate(propertyId);
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Step one of an upload: the API signs a URL the browser PUTs the file to.
 * The bytes never come through this server — a Next.js server action has a
 * body limit too, and a photo is exactly the payload it exists to avoid.
 */
export async function createMediaUpload(
  propertyId: string,
  input: CreateMediaUploadInput,
): Promise<ActionResult<MediaUploadGrant>> {
  try {
    return { ok: true, data: await api.createMediaUpload(propertyId, input) };
  } catch (error) {
    return failure(error);
  }
}

/** Step two, after the PUT succeeded: the row that makes the photo visible. */
export async function attachMedia(
  propertyId: string,
  input: AttachMediaInput,
): Promise<ActionResult<MediaItem>> {
  try {
    const data = await api.attachMedia(propertyId, input);
    revalidate(propertyId);
    revalidatePath(`/properties/${propertyId}/room-types`);
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function updateMedia(
  propertyId: string,
  mediaId: string,
  input: UpdateMediaInput,
): Promise<ActionResult<MediaItem>> {
  try {
    const data = await api.updateMedia(propertyId, mediaId, input);
    revalidate(propertyId);
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function deleteMedia(
  propertyId: string,
  mediaId: string,
): Promise<ActionResult<void>> {
  try {
    await api.deleteMedia(propertyId, mediaId);
    revalidate(propertyId);
    revalidatePath(`/properties/${propertyId}/room-types`);
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
