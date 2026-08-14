'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, type Expense, type NewExpenseInput } from '@/lib/api';

/**
 * Server actions for the books.
 *
 * Same shape as every other actions file here: a discriminated result rather
 * than a thrown error, so the form can map a code to a translated message
 * instead of showing whatever the server said in English.
 */

export interface ActionResult<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

function failure(error: unknown): ActionResult<never> {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: {
        // The duplicate-invoice guard reports its code in `details`, because
        // the HTTP status is a plain 409 and the form needs to say which of
        // several conflicts this was.
        code: (error.details as { code?: string } | undefined)?.code ?? error.code,
        message: error.message,
      },
    };
  }
  return { ok: false, error: { message: 'Unexpected error' } };
}

export async function recordExpense(
  propertyId: string,
  input: NewExpenseInput,
): Promise<ActionResult<Expense>> {
  try {
    const expense = await api.createExpense(propertyId, input);
    revalidatePath(`/properties/${propertyId}/accounting`);
    return { ok: true, data: expense };
  } catch (error) {
    return failure(error);
  }
}

export async function voidExpense(
  propertyId: string,
  expenseId: string,
  reason: string,
): Promise<ActionResult<Expense>> {
  try {
    const expense = await api.voidExpense(propertyId, expenseId, reason);
    revalidatePath(`/properties/${propertyId}/accounting`);
    return { ok: true, data: expense };
  } catch (error) {
    return failure(error);
  }
}

export async function createVendor(
  propertyId: string,
  input: { name: string; taxId?: string | null; taxpayerType?: string | null; isForeign?: boolean },
): Promise<ActionResult<{ id: string; name: string }>> {
  try {
    const vendor = await api.createVendor(propertyId, input);
    revalidatePath(`/properties/${propertyId}/accounting`);
    return { ok: true, data: vendor };
  } catch (error) {
    return failure(error);
  }
}
