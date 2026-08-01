import { describe, expect, it } from 'vitest';
import { toIsoDate } from '@deehub/shared';
import {
  computeTotals,
  exceedsRefundable,
  type ExtraChargeLine,
  type PaymentLine,
  type RoomChargeLine,
} from './folio';

/** Thai default: 10% service charge, then 7% VAT on the sum (ADR-0003). */
const THAI = { taxRateBp: 700, serviceChargeRateBp: 1000, pricesIncludeTax: false };
const NO_TAX = { taxRateBp: 0, serviceChargeRateBp: 0, pricesIncludeTax: false };

function night(amountMinor: number, date = '2026-09-01'): RoomChargeLine {
  return { date: toIsoDate(date), stayId: 'stay-1', roomTypeName: 'Deluxe', amountMinor };
}

function extra(overrides: Partial<ExtraChargeLine> = {}): ExtraChargeLine {
  return {
    id: 'charge-1',
    kind: 'MINIBAR',
    description: null,
    amountMinor: 15000,
    taxable: true,
    businessDate: toIsoDate('2026-09-01'),
    postedAt: new Date('2026-09-01T10:00:00Z'),
    postedBy: 'Somchai',
    voidedAt: null,
    voidedReason: null,
    ...overrides,
  };
}

function payment(overrides: Partial<PaymentLine> = {}): PaymentLine {
  return {
    id: 'payment-1',
    kind: 'PAYMENT',
    method: 'CASH',
    amountMinor: 100000,
    reference: null,
    businessDate: toIsoDate('2026-09-01'),
    recordedAt: new Date('2026-09-01T10:00:00Z'),
    recordedBy: 'Somchai',
    voidedAt: null,
    voidedReason: null,
    ...overrides,
  };
}

describe('computeTotals', () => {
  it('charges nothing for an empty account', () => {
    const totals = computeTotals([], [], [], 'THB', THAI);
    expect(totals.chargesTotal.amount).toBe(0);
    expect(totals.balance.amount).toBe(0);
  });

  it('composes service charge then VAT over the room nights', () => {
    // 1000.00 room + 10% service = 1100.00, + 7% VAT = 1177.00.
    const totals = computeTotals([night(100000)], [], [], 'THB', THAI);
    expect(totals.roomSubtotal.amount).toBe(100000);
    expect(totals.serviceCharge.amount).toBe(10000);
    expect(totals.tax.amount).toBe(7700);
    expect(totals.chargesTotal.amount).toBe(117700);
  });

  it('runs taxable extras through the same composition as the room', () => {
    /*
     * The whole reason extras join the room subtotal rather than being taxed
     * separately: two roundings produce a total a baht or two away from the one
     * a guest gets by adding the printed lines.
     */
    const together = computeTotals(
      [night(100000)],
      [extra({ amountMinor: 15000 })],
      [],
      'THB',
      THAI,
    );
    const asOneRoom = computeTotals([night(115000)], [], [], 'THB', THAI);
    expect(together.chargesTotal.amount).toBe(asOneRoom.chargesTotal.amount);
  });

  it('splits the subtotal into rooms and extras that add back exactly', () => {
    const totals = computeTotals([night(100000)], [extra({ amountMinor: 15000 })], [], 'THB', THAI);
    expect(totals.roomSubtotal.amount + totals.extrasSubtotal.amount).toBe(115000);
    expect(totals.extrasSubtotal.amount).toBe(15000);
  });

  it('adds an untaxed charge after the tax, not into it', () => {
    // A damage recovery is not a sale; VAT on it would overcharge the guest and
    // misstate the property's output tax.
    const taxed = computeTotals([night(100000)], [], [], 'THB', THAI);
    const withDamage = computeTotals(
      [night(100000)],
      [extra({ kind: 'DAMAGE', amountMinor: 50000, taxable: false })],
      [],
      'THB',
      THAI,
    );
    expect(withDamage.tax.amount).toBe(taxed.tax.amount);
    expect(withDamage.untaxedExtras.amount).toBe(50000);
    expect(withDamage.chargesTotal.amount).toBe(taxed.chargesTotal.amount + 50000);
  });

  it('ignores a voided charge in the arithmetic', () => {
    const totals = computeTotals(
      [night(100000)],
      [extra({ voidedAt: new Date(), voidedReason: 'Wrong room' })],
      [],
      'THB',
      THAI,
    );
    expect(totals.chargesTotal.amount).toBe(117700);
  });

  it('ignores a voided payment in the arithmetic', () => {
    const totals = computeTotals(
      [night(100000)],
      [],
      [payment({ voidedAt: new Date(), voidedReason: 'Keyed twice' })],
      'THB',
      THAI,
    );
    expect(totals.paid.amount).toBe(0);
    expect(totals.balance.amount).toBe(117700);
  });

  it('keeps payments and refunds apart rather than netting them', () => {
    // A cashier counting a drawer needs "taken today" and "given back today"
    // separately; a net figure hides both.
    const totals = computeTotals(
      [night(100000)],
      [],
      [payment({ amountMinor: 120000 }), payment({ id: 'p2', kind: 'REFUND', amountMinor: 20000 })],
      'THB',
      THAI,
    );
    expect(totals.paid.amount).toBe(120000);
    expect(totals.refunded.amount).toBe(20000);
    expect(totals.balance.amount).toBe(117700 - 100000);
  });

  it('goes negative when the guest has overpaid', () => {
    const totals = computeTotals(
      [night(100000)],
      [],
      [payment({ amountMinor: 200000 })],
      'THB',
      THAI,
    );
    // The hotel owes them. Clamping to zero would hide a refund that is due.
    expect(totals.balance.amount).toBe(117700 - 200000);
    expect(totals.balance.amount).toBeLessThan(0);
  });

  it('leaves the total alone when the property charges no tax', () => {
    const totals = computeTotals(
      [night(100000)],
      [extra({ amountMinor: 15000 })],
      [],
      'THB',
      NO_TAX,
    );
    expect(totals.chargesTotal.amount).toBe(115000);
    expect(totals.tax.amount).toBe(0);
    expect(totals.serviceCharge.amount).toBe(0);
  });

  it('treats a tax-inclusive rate as the amount the guest pays', () => {
    const totals = computeTotals([night(117700)], [], [], 'THB', {
      ...THAI,
      pricesIncludeTax: true,
    });
    expect(totals.chargesTotal.amount).toBe(117700);
    // And the tax is inside it, not on top.
    expect(totals.roomSubtotal.amount).toBeLessThan(117700);
  });
});

describe('exceedsRefundable', () => {
  const totals = computeTotals([], [], [payment({ amountMinor: 50000 })], 'THB', THAI);

  it('allows a refund of everything taken', () => {
    expect(exceedsRefundable(50000, totals)).toBe(false);
  });

  it('refuses a refund larger than what was taken', () => {
    // Not a rounding problem: it is a cashier typing into the wrong booking.
    expect(exceedsRefundable(50001, totals)).toBe(true);
  });

  it('counts what has already been given back', () => {
    const partly = computeTotals(
      [],
      [],
      [payment({ amountMinor: 50000 }), payment({ id: 'p2', kind: 'REFUND', amountMinor: 30000 })],
      'THB',
      THAI,
    );
    expect(exceedsRefundable(20000, partly)).toBe(false);
    expect(exceedsRefundable(20001, partly)).toBe(true);
  });

  it('refuses any refund when nothing has been paid', () => {
    const nothing = computeTotals([], [], [], 'THB', THAI);
    expect(exceedsRefundable(1, nothing)).toBe(true);
  });
});
