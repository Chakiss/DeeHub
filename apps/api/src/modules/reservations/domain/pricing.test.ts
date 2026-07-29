import { describe, expect, it } from 'vitest';
import { money, toMajorUnits } from '@deehub/shared';
import { computeBreakdown, type TaxConfig } from './pricing';

const THAI: TaxConfig = {
  taxRateBp: 700, // 7% VAT
  serviceChargeRateBp: 1000, // 10% service charge
  pricesIncludeTax: false,
};

describe('computeBreakdown() — tax-exclusive', () => {
  it('applies service charge, then VAT on room + service charge', () => {
    // ฿2,500/night × 3 = ฿7,500
    const nights = [money(250000, 'THB'), money(250000, 'THB'), money(250000, 'THB')];
    const result = computeBreakdown(nights, 'THB', THAI);

    expect(result.subtotal.amount).toBe(750000); // ฿7,500.00
    expect(result.serviceCharge.amount).toBe(75000); // 10% = ฿750.00
    // 7% of (7500 + 750) = ฿577.50 — NOT 7% of 7500 (฿525.00)
    expect(result.tax.amount).toBe(57750);
    expect(result.total.amount).toBe(882750); // ฿8,827.50
  });

  it('does not apply VAT to the bare room rate', () => {
    const result = computeBreakdown([money(100000, 'THB')], 'THB', THAI);
    const vatOnRoomOnly = 7000;
    expect(result.tax.amount).toBeGreaterThan(vatOnRoomOnly);
    expect(result.tax.amount).toBe(7700); // 7% of 1100.00
  });

  it('keeps components summing to the total', () => {
    const nights = [money(333333, 'THB'), money(111111, 'THB')];
    const r = computeBreakdown(nights, 'THB', THAI);
    expect(r.subtotal.amount + r.serviceCharge.amount + r.tax.amount).toBe(r.total.amount);
  });

  it('handles a zero-rate night (complimentary stay)', () => {
    const r = computeBreakdown([money(0, 'THB')], 'THB', THAI);
    expect(r.subtotal.amount).toBe(0);
    expect(r.total.amount).toBe(0);
  });

  it('supports a property with no service charge', () => {
    const r = computeBreakdown([money(100000, 'THB')], 'THB', {
      ...THAI,
      serviceChargeRateBp: 0,
    });
    expect(r.serviceCharge.amount).toBe(0);
    expect(r.tax.amount).toBe(7000);
    expect(r.total.amount).toBe(107000);
  });

  it('supports a tax-free property', () => {
    const r = computeBreakdown([money(100000, 'THB')], 'THB', {
      taxRateBp: 0,
      serviceChargeRateBp: 0,
      pricesIncludeTax: false,
    });
    expect(r.total.amount).toBe(100000);
  });

  it('never produces fractional minor units', () => {
    const r = computeBreakdown([money(99999, 'THB')], 'THB', THAI);
    for (const value of [r.subtotal, r.serviceCharge, r.tax, r.total]) {
      expect(Number.isInteger(value.amount)).toBe(true);
    }
  });
});

describe('computeBreakdown() — tax-inclusive', () => {
  const INCLUSIVE: TaxConfig = { ...THAI, pricesIncludeTax: true };

  it('charges the guest exactly the advertised price', () => {
    const advertised = money(882750, 'THB'); // ฿8,827.50
    const r = computeBreakdown([advertised], 'THB', INCLUSIVE);
    expect(r.total.amount).toBe(882750);
  });

  it('recovers the net rate that produced the gross', () => {
    // Inverse of the exclusive example above.
    const r = computeBreakdown([money(882750, 'THB')], 'THB', INCLUSIVE);
    expect(r.subtotal.amount).toBe(750000);
    expect(r.serviceCharge.amount).toBe(75000);
    expect(r.tax.amount).toBe(57750);
  });

  it('makes components sum to the gross EXACTLY despite rounding', () => {
    // Awkward amounts where naive rounding drifts by a satang.
    for (const gross of [100001, 33333, 77777, 1, 7, 999999]) {
      const r = computeBreakdown([money(gross, 'THB')], 'THB', INCLUSIVE);
      expect(r.subtotal.amount + r.serviceCharge.amount + r.tax.amount).toBe(gross);
      expect(r.total.amount).toBe(gross);
    }
  });

  it('round-trips against the exclusive calculation', () => {
    const net = money(123456, 'THB');
    const exclusive = computeBreakdown([net], 'THB', THAI);
    const inclusive = computeBreakdown([exclusive.total], 'THB', INCLUSIVE);
    // Reversing the markups lands within a satang of the original net.
    expect(Math.abs(inclusive.subtotal.amount - net.amount)).toBeLessThanOrEqual(1);
    expect(inclusive.total.amount).toBe(exclusive.total.amount);
  });

  it('formats to a sane major-unit amount', () => {
    const r = computeBreakdown([money(882750, 'THB')], 'THB', INCLUSIVE);
    expect(toMajorUnits(r.total)).toBe(8827.5);
  });
});
