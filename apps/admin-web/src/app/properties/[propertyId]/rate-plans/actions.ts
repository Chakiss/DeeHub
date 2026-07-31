'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiError,
  api,
  type CreateRatePlanInput,
  type RatePlan,
  type RateDeletion,
  type RateUpdate,
  type UpdateRatePlanInput,
} from '@/lib/api';

export interface RatePlanResult {
  readonly ok: boolean;
  readonly ratePlan?: RatePlan;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface RatesResult {
  readonly ok: boolean;
  readonly pricesUpdated?: number;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface RateDeletionActionResult {
  readonly ok: boolean;
  readonly pricesRemoved?: number;
  /** Nights that still have allotment but can no longer be sold at all. */
  readonly nightsNowUnsellable?: number;
  readonly error?: { code: string; message: string; details?: Record<string, unknown> };
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    return {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  throw error;
}

/** Prices feed the inventory grid's cells, so both pages go stale together. */
function revalidate(propertyId: string): void {
  revalidatePath(`/properties/${propertyId}/rate-plans`);
  revalidatePath(`/properties/${propertyId}/inventory`);
}

export async function createRatePlan(
  propertyId: string,
  input: CreateRatePlanInput,
): Promise<RatePlanResult> {
  try {
    const ratePlan = await api.createRatePlan(propertyId, input);
    revalidate(propertyId);
    return { ok: true, ratePlan };
  } catch (error) {
    return failure(error);
  }
}

export async function updateRatePlan(
  propertyId: string,
  ratePlanId: string,
  input: UpdateRatePlanInput,
): Promise<RatePlanResult> {
  try {
    const ratePlan = await api.updateRatePlan(propertyId, ratePlanId, input);
    revalidate(propertyId);
    return { ok: true, ratePlan };
  } catch (error) {
    return failure(error);
  }
}

export async function updateRates(propertyId: string, updates: RateUpdate[]): Promise<RatesResult> {
  try {
    const result = await api.updateRates(propertyId, updates);
    revalidate(propertyId);
    return { ok: true, pricesUpdated: result.pricesUpdated };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Remove prices over a range.
 *
 * NOT the same as setting them to zero, which is the only thing that was
 * possible before and which leaves the room sellable for nothing. A night with
 * no price cannot be booked at all — so the result reports how many nights this
 * just took off sale, and the dialog says so out loud.
 */
export async function deleteRates(
  propertyId: string,
  deletions: RateDeletion[],
): Promise<RateDeletionActionResult> {
  try {
    const result = await api.deleteRates(propertyId, deletions);
    revalidate(propertyId);
    return {
      ok: true,
      pricesRemoved: result.pricesRemoved,
      nightsNowUnsellable: result.nightsNowUnsellable,
    };
  } catch (error) {
    return failure(error);
  }
}
