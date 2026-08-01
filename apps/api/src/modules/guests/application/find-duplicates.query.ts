import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@deehub/shared';
import { DATABASE, type Database } from '../../../database/database.module';
import { GUEST_REPOSITORY, type GuestRepository } from '../domain/guest.repository';
import {
  confidenceOf,
  rankCandidates,
  signalsBetween,
  type DuplicateCandidate,
} from '../domain/guest-merge';

/**
 * More than a person will work through in one sitting, and a hard stop on a
 * pathological case — a hotel that imported a thousand rows with a blank email
 * would otherwise turn one screen into a thousand-row scan.
 */
const MAX_CANDIDATES = 20;

/**
 * Who else might be this guest.
 *
 * The database finds the candidates and the domain explains them: the SQL knows
 * how to match nine trailing digits across a million rows, and the scoring is a
 * judgement about how much to trust each signal, which belongs somewhere a
 * person can read and argue with.
 */
@Injectable()
export class FindDuplicatesQuery {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(GUEST_REPOSITORY) private readonly repo: GuestRepository,
  ) {}

  async execute(guestId: string): Promise<readonly DuplicateCandidate[]> {
    const subject = await this.repo.findById(this.db, guestId);
    if (!subject) throw errors.notFound('Guest', guestId);

    const candidates = await this.repo.findDuplicateCandidates(this.db, guestId, MAX_CANDIDATES);

    return rankCandidates(
      candidates.map((guest) => {
        const signals = signalsBetween(subject, guest);
        return { guest, signals, confidence: confidenceOf(signals) };
      }),
    );
  }
}
