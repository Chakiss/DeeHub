import { Inject, Injectable } from '@nestjs/common';
import { newId } from '../../../common/ids';
import type { Executor } from '../../../database/executor';
import { GUEST_REPOSITORY, splitName, type GuestRepository } from '../domain/guest.repository';

export interface LinkGuestInput {
  readonly organizationId: string;
  readonly name: string;
  readonly email?: string | null;
  readonly phone?: string | null;
}

/**
 * Find or create the guest behind a booking.
 *
 * Runs inside the booking transaction: a reservation that committed without
 * its guest would leave a profile-less booking that nothing later repairs.
 *
 * Matching is deliberately conservative — see GuestRepository.findMatch. When
 * in doubt this creates a second profile rather than attaching a stay to
 * somebody who may not be the same person.
 */
@Injectable()
export class LinkGuestUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly repo: GuestRepository) {}

  async execute(tx: Executor, input: LinkGuestInput): Promise<string> {
    const { firstName, lastName } = splitName(input.name);
    const email = input.email?.trim() || null;
    const phone = input.phone?.trim() || null;

    const existing = await this.repo.findMatch(tx, email, lastName);
    if (existing) return existing.id;

    const id = newId();
    await this.repo.insert(tx, {
      id,
      organizationId: input.organizationId,
      firstName,
      lastName,
      email,
      phone,
    });
    return id;
  }
}
