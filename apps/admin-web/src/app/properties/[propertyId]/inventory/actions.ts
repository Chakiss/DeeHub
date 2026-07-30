'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type InventoryUpdate } from '@/lib/api';

export interface UpdateResult {
  readonly ok: boolean;
  readonly nightsUpdated?: number;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

/**
 * Apply a bulk inventory edit.
 *
 * A server action rather than a route handler: it runs on the server with the
 * session cookie already available, and can revalidate the page in the same
 * round trip so the grid reflects the change without a manual refetch.
 */
export async function updateInventory(
  propertyId: string,
  updates: InventoryUpdate[],
): Promise<UpdateResult> {
  try {
    const result = await api.updateInventory(propertyId, updates);
    revalidatePath(`/properties/${propertyId}/inventory`);
    return { ok: true, nightsUpdated: result.nightsUpdated };
  } catch (error) {
    if (error instanceof ApiError) {
      // Typed errors are passed through so the UI can explain exactly which
      // dates blocked the edit, rather than showing a generic failure.
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
}
