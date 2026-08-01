import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_MINOR,
  MAX_PERCENTAGE_BP,
  MIN_PERCENTAGE_BP,
  assertDerivable,
  assertDerivationValue,
  describeDerivation,
} from './derivation';
import type { RatePlanRecord } from './rate-plan.repository';

function plan(overrides: Partial<RatePlanRecord> = {}): RatePlanRecord {
  return {
    id: 'parent-1',
    propertyId: 'property-1',
    roomTypeId: 'deluxe',
    code: 'BAR',
    name: 'Best Available',
    mealPlan: 'ROOM_ONLY',
    isRefundable: true,
    isActive: true,
    parentRatePlanId: null,
    derivationType: null,
    derivationValue: null,
    ...overrides,
  };
}

describe('assertDerivationValue', () => {
  it('accepts an ordinary discount and an ordinary uplift', () => {
    expect(() => assertDerivationValue('PERCENTAGE', -1000)).not.toThrow();
    expect(() => assertDerivationValue('AMOUNT', 30000)).not.toThrow();
  });

  it('refuses a percentage that would give the room away', () => {
    // At −100% every night computes to zero, and a zero-priced night sells the
    // room for nothing — the same rule the rate editor follows by removing
    // prices rather than zeroing them.
    expect(() => assertDerivationValue('PERCENTAGE', -10000)).toThrow();
    expect(() => assertDerivationValue('PERCENTAGE', MIN_PERCENTAGE_BP - 1)).toThrow();
    expect(() => assertDerivationValue('PERCENTAGE', MIN_PERCENTAGE_BP)).not.toThrow();
  });

  it('allows a plan priced above its parent', () => {
    // Breakfast included, or a flexible rate above a non-refundable one.
    expect(() => assertDerivationValue('PERCENTAGE', MAX_PERCENTAGE_BP)).not.toThrow();
    expect(() => assertDerivationValue('PERCENTAGE', MAX_PERCENTAGE_BP + 1)).toThrow();
  });

  it('refuses an offset that would duplicate the parent', () => {
    // Two plans at one price is a mapping mistake at every OTA it reaches.
    expect(() => assertDerivationValue('PERCENTAGE', 0)).toThrow();
    expect(() => assertDerivationValue('AMOUNT', 0)).toThrow();
  });

  it('refuses an amount larger than any real room rate', () => {
    expect(() => assertDerivationValue('AMOUNT', MAX_AMOUNT_MINOR + 1)).toThrow();
    expect(() => assertDerivationValue('AMOUNT', -MAX_AMOUNT_MINOR - 1)).toThrow();
  });

  it('refuses a fraction of a basis point', () => {
    expect(() => assertDerivationValue('PERCENTAGE', -1000.5)).toThrow();
  });
});

describe('assertDerivable', () => {
  it('accepts a base plan on the same room type', () => {
    expect(() => assertDerivable(plan(), 'parent-1', 'deluxe')).not.toThrow();
  });

  it('refuses a parent that does not exist', () => {
    expect(() => assertDerivable(null, 'parent-1', 'deluxe')).toThrow();
  });

  it('refuses a parent on a different room type', () => {
    // It would price a room from a different room's price, and break the
    // lead-rate query, which groups by the plan's own room type.
    expect(() => assertDerivable(plan(), 'parent-1', 'standard')).toThrow();
  });

  it('refuses a chain', () => {
    // A derived plan reads its parent's STORED rows. A parent that is itself
    // derived has none, so the child would resolve to no price at all.
    const alreadyDerived = plan({ parentRatePlanId: 'grandparent', derivationType: 'PERCENTAGE' });
    expect(() => assertDerivable(alreadyDerived, 'parent-1', 'deluxe')).toThrow();
  });

  it('refuses a parent that is no longer selling', () => {
    // An inactive parent is excluded from the lead rate and from ARI pushes; a
    // child of one would look configured and reach nobody.
    expect(() => assertDerivable(plan({ isActive: false }), 'parent-1', 'deluxe')).toThrow();
  });
});

describe('describeDerivation', () => {
  it('reads as a discount or an uplift', () => {
    expect(describeDerivation('PERCENTAGE', -1000)).toBe('−10%');
    expect(describeDerivation('PERCENTAGE', 1550)).toBe('+15.5%');
    expect(describeDerivation('AMOUNT', -20000)).toBe('−200');
    expect(describeDerivation('AMOUNT', 30000)).toBe('+300');
  });

  it('uses a real minus sign rather than a hyphen', () => {
    // A hyphen next to a digit reads as a range on a dense screen.
    expect(describeDerivation('PERCENTAGE', -1000).startsWith('−')).toBe(true);
  });
});
