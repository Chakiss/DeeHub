import { errors } from '@deehub/shared';
import type { RatePlanRecord } from './rate-plan.repository';

/**
 * Pricing a rate plan as an offset from another one (roadmap Phase 3).
 *
 * A hotel sells the same room several ways — Best Available, non-refundable at
 * 10% less, breakfast included at 300 more — and maintaining every one of them
 * by hand across a 400-night horizon is how prices drift apart. A derived plan
 * has no prices of its own; `effective_rate_days` computes them from its parent.
 */

export const DERIVATION_TYPES = ['PERCENTAGE', 'AMOUNT'] as const;
export type DerivationType = (typeof DERIVATION_TYPES)[number];

export interface Derivation {
  readonly parentRatePlanId: string;
  readonly type: DerivationType;
  /** Signed. Basis points for PERCENTAGE, minor units for AMOUNT. */
  readonly value: number;
}

/**
 * Bounds on a percentage offset.
 *
 * The floor stops short of −100%: at exactly −10000 bp every night computes to
 * zero, and a zero-priced night is a room given away — the same reason the rate
 * editor removes prices instead of zeroing them. The ceiling is generous
 * because a plan priced ABOVE its parent is ordinary (breakfast included, a
 * flexible rate above a non-refundable one), and there is no principled maximum
 * beyond stopping a typo becoming a hundredfold markup.
 */
export const MIN_PERCENTAGE_BP = -9900;
export const MAX_PERCENTAGE_BP = 100_000;

/**
 * Bounds on an amount offset, in minor units.
 *
 * Symmetric, and large enough for any real room rate. A negative offset larger
 * than the parent's price simply produces a night with no price at all, which
 * the view filters out — see `effective_rate_days`.
 */
export const MAX_AMOUNT_MINOR = 100_000_000;

export function assertDerivationValue(type: DerivationType, value: number): void {
  if (!Number.isInteger(value)) {
    throw errors.validation('A derivation must be a whole number of basis points or minor units');
  }

  if (type === 'PERCENTAGE') {
    if (value < MIN_PERCENTAGE_BP || value > MAX_PERCENTAGE_BP) {
      throw errors.validation(
        `A percentage derivation must be between ${String(MIN_PERCENTAGE_BP / 100)}% and ` +
          `${String(MAX_PERCENTAGE_BP / 100)}%`,
        { value },
      );
    }
    if (value === 0) {
      // Not pedantry: a plan that always equals its parent is two plans sold at
      // one price, which is a mapping mistake at every OTA it reaches.
      throw errors.validation('A derivation of 0% would just duplicate the parent plan');
    }
    return;
  }

  if (Math.abs(value) > MAX_AMOUNT_MINOR) {
    throw errors.validation('That derivation is larger than any real room rate', { value });
  }
  if (value === 0) {
    throw errors.validation('A derivation of zero would just duplicate the parent plan');
  }
}

/**
 * Whether `parent` can be the parent of a plan on `roomTypeId`.
 *
 * **Same room type.** A rate plan belongs to one room type, and deriving a
 * Deluxe rate from a Standard one would price a room from a different room's
 * price — which is a thing hotels do commercially, and is not what this
 * mechanism means. It would also break the lead-rate query, which groups by the
 * plan's own room type.
 *
 * **One level, no chains.** A derived plan's price comes from its parent's
 * STORED rows; a parent that is itself derived has none. The view already
 * resolves such a plan to no price at all, so refusing here turns a silently
 * unsellable plan into a message at the moment somebody creates it.
 */
export function assertDerivable(
  parent: (RatePlanRecord & { parentRatePlanId: string | null }) | null,
  parentId: string,
  roomTypeId: string,
): void {
  if (!parent) throw errors.notFound('Rate plan', parentId);

  if (parent.roomTypeId !== roomTypeId) {
    throw errors.validation('A derived plan must share the room type of the plan it derives from', {
      parentRatePlanId: parentId,
    });
  }

  if (parent.parentRatePlanId !== null) {
    throw errors.validation(
      'That plan is itself derived. A derived plan must point at one that holds its own prices.',
      { parentRatePlanId: parentId },
    );
  }

  if (!parent.isActive) {
    // An inactive parent has prices but is excluded from the lead rate and from
    // ARI pushes; a child of one would look configured and reach nobody.
    throw errors.validation('A derived plan cannot point at a plan that is no longer selling', {
      parentRatePlanId: parentId,
    });
  }
}

/** How the offset reads on a screen: "−10%", "+฿300". */
export function describeDerivation(type: DerivationType, value: number): string {
  const sign = value < 0 ? '−' : '+';
  const magnitude = Math.abs(value);
  return type === 'PERCENTAGE'
    ? `${sign}${String(magnitude / 100)}%`
    : `${sign}${String(magnitude / 100)}`;
}
