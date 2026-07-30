'use server';

import { revalidatePath } from 'next/cache';
import {
  ApiError,
  api,
  type CreateRatePlanInput,
  type RatePlan,
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
  readonly nightsUpdated?: number;
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
    return { ok: true, nightsUpdated: result.nightsUpdated };
  } catch (error) {
    return failure(error);
  }
}
