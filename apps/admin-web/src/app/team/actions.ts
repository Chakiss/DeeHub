'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, api, type InvitedUser, type OrganizationUser } from '@/lib/api';

export interface InviteResult {
  readonly ok: boolean;
  readonly user?: InvitedUser;
  readonly error?: { code: string; message: string };
}

export interface UpdateResult {
  readonly ok: boolean;
  readonly user?: OrganizationUser;
  readonly error?: { code: string; message: string };
}

function failure(error: unknown) {
  if (error instanceof ApiError) {
    return { ok: false as const, error: { code: error.code, message: error.message } };
  }
  throw error;
}

export async function inviteUser(input: {
  email: string;
  fullName: string;
  role: string;
}): Promise<InviteResult> {
  try {
    const user = await api.inviteUser(input);
    revalidatePath('/team');
    // The temporary password travels back to the caller's browser and is shown
    // once. It is never persisted here and never written to a log.
    return { ok: true, user };
  } catch (error) {
    return failure(error);
  }
}

export interface ResetResult {
  readonly ok: boolean;
  readonly reset?: { email: string; fullName: string; temporaryPassword: string };
  readonly error?: { code: string; message: string };
}

/**
 * The whole recovery story today. There is no outbound mail, so the new
 * credential comes back to the operator who asked for it and they relay it.
 */
export async function resetUserPassword(userId: string): Promise<ResetResult> {
  try {
    const reset = await api.resetUserPassword(userId);
    revalidatePath('/team');
    return { ok: true, reset };
  } catch (error) {
    return failure(error);
  }
}

export async function updateUser(
  userId: string,
  input: { fullName?: string; role?: string; status?: 'ACTIVE' | 'DISABLED' },
): Promise<UpdateResult> {
  try {
    const user = await api.updateUser(userId, input);
    revalidatePath('/team');
    return { ok: true, user };
  } catch (error) {
    return failure(error);
  }
}
