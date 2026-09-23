'use server';

import { revalidatePath } from 'next/cache';
import { api, ApiError, type AccountingSettings } from '@/lib/api';

export interface SettingsResult {
  ok: boolean;
  data?: AccountingSettings;
  error?: { code?: string; message?: string };
}

/** Record who the hotel is to the Revenue Department. */
export async function saveAccountingSettings(
  propertyId: string,
  input: Partial<AccountingSettings>,
): Promise<SettingsResult> {
  try {
    const settings = await api.saveAccountingSettings(propertyId, input);
    revalidatePath(`/properties/${propertyId}/accounting`);
    revalidatePath(`/properties/${propertyId}/accounting/settings`);
    return { ok: true, data: settings };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { message: 'Unexpected error' } };
  }
}
