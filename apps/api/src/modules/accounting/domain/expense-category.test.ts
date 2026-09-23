import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  EXPENSE_GROUP_ORDER,
  EXPENSE_GROUPS,
  WHT_INCOME_TYPES,
} from './expense-category';

describe('DEFAULT_EXPENSE_CATEGORIES', () => {
  it('has a unique code for every category', () => {
    const codes = DEFAULT_EXPENSE_CATEGORIES.map((category) => category.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses only declared groups and income types', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect(EXPENSE_GROUPS).toContain(category.group);
      if (category.defaultWhtIncomeType !== null) {
        expect(WHT_INCOME_TYPES).toContain(category.defaultWhtIncomeType);
      }
    }
  });

  it('names every category in both languages', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect(category.nameTh.trim().length).toBeGreaterThan(0);
      expect(category.nameEn.trim().length).toBeGreaterThan(0);
      // A Thai owner reads the Thai name; it must not be the English one.
      expect(category.nameTh).not.toBe(category.nameEn);
    }
  });

  /**
   * A rate with no income type cannot produce a withholding certificate — the
   * 50 ทวิ form has a box for the section of มาตรา 40 the payment falls under,
   * and leaving it blank makes the certificate unusable to the supplier.
   */
  it('pairs every non-zero withholding rate with an income type', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      if (category.defaultWhtRateBp > 0) {
        expect(category.defaultWhtIncomeType).not.toBeNull();
      }
    }
  });

  it('keeps every default rate within the rates Thai law actually uses', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect([0, 100, 200, 300, 500]).toContain(category.defaultWhtRateBp);
    }
  });

  it('withholds 5% on rent and 3% on professional fees', () => {
    const byCode = new Map(DEFAULT_EXPENSE_CATEGORIES.map((c) => [c.code, c]));
    expect(byCode.get('RENT')?.defaultWhtRateBp).toBe(500);
    expect(byCode.get('RENT')?.defaultWhtIncomeType).toBe('RENT_40_5');
    expect(byCode.get('ACCOUNTING')?.defaultWhtRateBp).toBe(300);
    expect(byCode.get('ACCOUNTING')?.defaultWhtIncomeType).toBe('PROFESSIONAL_40_6');
    expect(byCode.get('ADVERTISING')?.defaultWhtRateBp).toBe(200);
    expect(byCode.get('TRANSPORT')?.defaultWhtRateBp).toBe(100);
  });

  /** Nothing is withheld on buying things, only on paying for work. */
  it('does not withhold on goods', () => {
    const byCode = new Map(DEFAULT_EXPENSE_CATEGORIES.map((c) => [c.code, c]));
    for (const code of ['FNB_COST', 'AMENITIES', 'LINEN', 'OFFICE', 'FUEL']) {
      expect(byCode.get(code)?.defaultWhtRateBp).toBe(0);
    }
  });

  /**
   * Payroll withholding is real, progressive, and filed on ภ.ง.ด.1 — a payroll
   * system's job and an explicit non-goal in ADR-0008. Offering a flat rate
   * here would be worse than offering nothing.
   */
  it('proposes no rate for payroll', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES.filter((c) => c.group === 'PAYROLL')) {
      expect(category.defaultWhtRateBp).toBe(0);
    }
  });

  it("marks the owner's drawings as not deductible", () => {
    const draw = DEFAULT_EXPENSE_CATEGORIES.find((c) => c.code === 'OWNER_DRAW');
    expect(draw?.isDeductible).toBe(false);
    // And it is the only one, so a real cost is never silently excluded.
    expect(DEFAULT_EXPENSE_CATEGORIES.filter((c) => !c.isDeductible)).toHaveLength(1);
  });

  it('covers the bills a hotel cannot avoid', () => {
    const codes = new Set(DEFAULT_EXPENSE_CATEGORIES.map((c) => c.code));
    for (const essential of [
      'ELECTRICITY',
      'WATER',
      'SALARY',
      'LAUNDRY',
      'MAINTENANCE',
      'OTA_COMMISSION',
      'RENT',
      'ACCOUNTING',
    ]) {
      expect(codes).toContain(essential);
    }
  });
});

describe('EXPENSE_GROUP_ORDER', () => {
  it('lists every group exactly once, so no expense falls off the report', () => {
    expect([...EXPENSE_GROUP_ORDER].sort()).toEqual([...EXPENSE_GROUPS].sort());
    expect(new Set(EXPENSE_GROUP_ORDER).size).toBe(EXPENSE_GROUP_ORDER.length);
  });

  it('has a home for every seeded category', () => {
    for (const category of DEFAULT_EXPENSE_CATEGORIES) {
      expect(EXPENSE_GROUP_ORDER).toContain(category.group);
    }
  });
});
