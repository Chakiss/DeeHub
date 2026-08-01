'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type DuplicateGuest, type MergeGuestResult } from '@/lib/api';

export interface DuplicatesResult {
  readonly ok: boolean;
  readonly items?: DuplicateGuest[];
  readonly error?: { code: string; message: string };
}

export interface MergeResult {
  readonly ok: boolean;
  readonly merged?: MergeGuestResult;
  readonly error?: { code: string; message: string };
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    return { ok: false as const, error: { code: error.code, message: error.message } };
  }
  throw error;
}

/** Loaded on demand: most rows have no duplicates and nobody opens the panel. */
export async function findDuplicates(
  propertyId: string,
  guestId: string,
): Promise<DuplicatesResult> {
  try {
    return { ok: true, items: await api.guestDuplicates(propertyId, guestId) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The guest whose row this is survives; the candidate is folded into it.
 *
 * Revalidates the list because the merge changes two rows and removes one —
 * a stale table would still offer the profile that no longer exists.
 */
export async function mergeGuest(
  propertyId: string,
  survivorId: string,
  duplicateId: string,
): Promise<MergeResult> {
  try {
    const merged = await api.mergeGuest(propertyId, survivorId, duplicateId);
    revalidatePath(`/properties/${propertyId}/guests`);
    return { ok: true, merged };
  } catch (error) {
    return failure(error);
  }
}
