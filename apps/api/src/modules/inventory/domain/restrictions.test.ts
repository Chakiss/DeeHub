import { describe, expect, it } from 'vitest';
import { nightsBetween, toIsoDate, type IsoDate } from '@deehub/shared';
import type { InventoryDay } from './inventory-day';
import { evaluateStay, isSellable, toDomainError, type StayRequest } from './restrictions';

const ROOM_TYPE = 'rt-1';

function day(date: string, overrides: Partial<InventoryDay> = {}): InventoryDay {
  return {
    roomTypeId: ROOM_TYPE,
    date: toIsoDate(date),
    allotment: 5,
    booked: 0,
    stopSell: false,
    minStay: 1,
    maxStay: null,
    closedToArrival: false,
    closedToDeparture: false,
    ...overrides,
  };
}

function calendar(...days: InventoryDay[]): Map<string, InventoryDay> {
  return new Map(days.map((d) => [d.date, d]));
}

function stay(checkIn: string, checkOut: string, units = 1): StayRequest {
  const from = toIsoDate(checkIn);
  const to = toIsoDate(checkOut);
  return { roomTypeId: ROOM_TYPE, nights: nightsBetween(from, to), checkOut: to, units };
}

describe('evaluateStay()', () => {
  it('accepts a stay when every night has capacity', () => {
    const report = evaluateStay(
      stay('2026-08-12', '2026-08-15'),
      calendar(day('2026-08-12'), day('2026-08-13'), day('2026-08-14'), day('2026-08-15')),
    );
    expect(isSellable(report)).toBe(true);
  });

  it('does not require an inventory row for the departure date', () => {
    // The guest leaves that morning; we never hold inventory for it.
    const report = evaluateStay(
      stay('2026-08-12', '2026-08-14'),
      calendar(day('2026-08-12'), day('2026-08-13')),
    );
    expect(isSellable(report)).toBe(true);
    expect(report.missingDates).toEqual([]);
  });

  it('reports a night that was never opened for sale as missing, not available', () => {
    const report = evaluateStay(
      stay('2026-08-12', '2026-08-14'),
      calendar(day('2026-08-12')), // 13th absent
    );
    expect(isSellable(report)).toBe(false);
    expect(report.missingDates).toEqual(['2026-08-13']);
  });

  it('reports every sold-out night, not just the first', () => {
    const report = evaluateStay(
      stay('2026-08-12', '2026-08-15'),
      calendar(
        day('2026-08-12', { allotment: 1, booked: 1 }),
        day('2026-08-13'),
        day('2026-08-14', { allotment: 2, booked: 2 }),
      ),
    );
    expect(report.soldOutDates).toEqual(['2026-08-12', '2026-08-14']);
  });

  it('respects the requested unit count', () => {
    const oneLeft = calendar(day('2026-08-12', { allotment: 3, booked: 2 }));
    expect(isSellable(evaluateStay(stay('2026-08-12', '2026-08-13', 1), oneLeft))).toBe(true);
    expect(isSellable(evaluateStay(stay('2026-08-12', '2026-08-13', 2), oneLeft))).toBe(false);
  });

  it('flags stop-sell even when units are available', () => {
    const report = evaluateStay(
      stay('2026-08-12', '2026-08-13'),
      calendar(day('2026-08-12', { stopSell: true, allotment: 10, booked: 0 })),
    );
    expect(report.violations[0]?.restriction).toBe('STOP_SELL');
    expect(report.soldOutDates).toEqual([]);
  });

  describe('length of stay', () => {
    it('enforces min stay on the arrival night', () => {
      const report = evaluateStay(
        stay('2026-12-31', '2027-01-01'),
        calendar(day('2026-12-31', { minStay: 3 }), day('2027-01-01')),
      );
      const violation = report.violations[0];
      expect(violation?.restriction).toBe('MIN_STAY');
      expect(violation?.detail).toEqual({ required: 3, requested: 1 });
    });

    it('accepts a stay that meets min stay', () => {
      const report = evaluateStay(
        stay('2026-12-31', '2027-01-03'),
        calendar(
          day('2026-12-31', { minStay: 3 }),
          day('2027-01-01'),
          day('2027-01-02'),
          day('2027-01-03'),
        ),
      );
      expect(isSellable(report)).toBe(true);
    });

    it('ignores min stay on nights the stay merely passes through', () => {
      // A 3-night minimum on the 13th must not block a 2-night stay that
      // ARRIVES on the 12th — the rule is about arrivals.
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-14'),
        calendar(day('2026-08-12'), day('2026-08-13', { minStay: 3 })),
      );
      expect(isSellable(report)).toBe(true);
    });

    it('enforces max stay', () => {
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-20'),
        calendar(
          day('2026-08-12', { maxStay: 5 }),
          ...['13', '14', '15', '16', '17', '18', '19'].map((d) => day(`2026-08-${d}`)),
        ),
      );
      expect(report.violations[0]?.restriction).toBe('MAX_STAY');
      expect(report.violations[0]?.detail).toEqual({ allowed: 5, requested: 8 });
    });
  });

  describe('arrival and departure closures', () => {
    it('blocks arrival on a closed-to-arrival night', () => {
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-14'),
        calendar(day('2026-08-12', { closedToArrival: true }), day('2026-08-13')),
      );
      expect(report.violations[0]?.restriction).toBe('CLOSED_TO_ARRIVAL');
    });

    it('allows passing through a closed-to-arrival night mid-stay', () => {
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-15'),
        calendar(
          day('2026-08-12'),
          day('2026-08-13', { closedToArrival: true }),
          day('2026-08-14'),
        ),
      );
      expect(isSellable(report)).toBe(true);
    });

    it('blocks departure on a closed-to-departure date', () => {
      // CTD lives on the CHECKOUT date, which is not a night we hold.
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-14'),
        calendar(
          day('2026-08-12'),
          day('2026-08-13'),
          day('2026-08-14', { closedToDeparture: true }),
        ),
      );
      expect(report.violations[0]?.restriction).toBe('CLOSED_TO_DEPARTURE');
      expect(report.violations[0]?.date).toBe('2026-08-14');
    });

    it('ignores closed-to-departure on nights the guest stays through', () => {
      const report = evaluateStay(
        stay('2026-08-12', '2026-08-15'),
        calendar(
          day('2026-08-12'),
          day('2026-08-13', { closedToDeparture: true }),
          day('2026-08-14'),
        ),
      );
      expect(isSellable(report)).toBe(true);
    });
  });
});

describe('toDomainError()', () => {
  it('prefers a restriction error and names the restriction', () => {
    const request = stay('2026-12-31', '2027-01-01');
    const report = evaluateStay(request, calendar(day('2026-12-31', { minStay: 3 })));
    const error = toDomainError(request, report) as Error & {
      code: string;
      details: Record<string, unknown>;
    };
    expect(error.code).toBe('RESTRICTION_VIOLATED');
    expect(error.details['restriction']).toBe('MIN_STAY');
    expect(error.message).toContain('3 nights');
  });

  it('reports unavailable dates when there is no restriction', () => {
    const request = stay('2026-08-12', '2026-08-14');
    const report = evaluateStay(
      request,
      calendar(day('2026-08-12', { allotment: 1, booked: 1 }), day('2026-08-13')),
    );
    const error = toDomainError(request, report) as Error & {
      code: string;
      details: Record<string, unknown>;
    };
    expect(error.code).toBe('INVENTORY_UNAVAILABLE');
    expect(error.details['unavailableDates']).toEqual(['2026-08-12']);
  });

  it('includes never-opened dates in the unavailable list', () => {
    const request = stay('2026-08-12', '2026-08-14');
    const report = evaluateStay(request, calendar(day('2026-08-12')));
    const error = toDomainError(request, report) as Error & { details: Record<string, unknown> };
    expect(error.details['unavailableDates']).toContain('2026-08-13');
  });
});

describe('night enumeration matches the shared kernel', () => {
  it('treats a stay as [checkIn, checkOut)', () => {
    const nights: readonly IsoDate[] = stay('2026-08-12', '2026-08-15').nights;
    expect(nights).toEqual(['2026-08-12', '2026-08-13', '2026-08-14']);
  });
});
