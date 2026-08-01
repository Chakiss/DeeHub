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
 * Recovery for the case self-service cannot reach: a mailbox the person can no
 * longer open. The new credential comes back to the operator who asked for it
 * and they relay it — it is never stored and never logged.
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
