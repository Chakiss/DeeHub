import { describe, expect, it } from 'vitest';
import { computeCancelQuote } from './cancellation-quote';

const deadline = new Date('2031-08-01T08:00:00Z');
const before = new Date('2031-08-01T07:00:00Z');
const policy = { noticeHours: 24, refundPercent: 50 };

function quote(overrides: Partial<Parameters<typeof computeCancelQuote>[0]> = {}) {
  return computeCancelQuote({
    policy,
    totalMinor: 90000,
    paidMinor: 90000,
    refundedMinor: 0,
    deadline,
    now: before,
    ...overrides,
  });
}

describe('computeCancelQuote()', () => {
  it('refunds the policy percentage of the total when fully paid and in time', () => {
    const result = quote();
    expect(result.suggestedRefundMinor).toBe(45000);
    expect(result.policy).toMatchObject({ noticeHours: 24, refundPercent: 50, inTime: true });
  });

  it('is capped by what was paid, never by the total alone', () => {
    expect(quote({ paidMinor: 30000 }).suggestedRefundMinor).toBe(30000);
  });

  it('counts refunds already given as no longer refundable', () => {
    expect(quote({ refundedMinor: 60000 }).suggestedRefundMinor).toBe(30000);
    expect(quote({ refundedMinor: 90000 }).suggestedRefundMinor).toBe(0);
  });

  it('is 0 when nothing was paid', () => {
    expect(quote({ paidMinor: 0 }).suggestedRefundMinor).toBe(0);
  });

  it('never goes negative when refunds exceed payments', () => {
    expect(quote({ paidMinor: 1000, refundedMinor: 5000 }).suggestedRefundMinor).toBe(0);
  });

  it('is 0 for a 0% policy', () => {
    expect(quote({ policy: { noticeHours: 0, refundPercent: 0 } }).suggestedRefundMinor).toBe(0);
  });

  it('returns everything paid for a 100% policy', () => {
    const result = quote({ policy: { noticeHours: 72, refundPercent: 100 } });
    expect(result.suggestedRefundMinor).toBe(90000);
  });

  it('floors to a whole minor unit', () => {
    // 33% of 1001 = 330.33
    expect(
      quote({ policy: { noticeHours: 1, refundPercent: 33 }, totalMinor: 1001, paidMinor: 1001 })
        .suggestedRefundMinor,
    ).toBe(330);
  });

  it('is 0 after the deadline but still reports the policy', () => {
    const result = quote({ now: new Date('2031-08-01T08:00:01Z') });
    expect(result.suggestedRefundMinor).toBe(0);
    expect(result.policy?.inTime).toBe(false);
  });

  it('treats exactly the deadline as in time', () => {
    const result = quote({ now: deadline });
    expect(result.policy?.inTime).toBe(true);
    expect(result.suggestedRefundMinor).toBe(45000);
  });

  it('quotes nothing when there is no policy of ours', () => {
    expect(quote({ policy: null, deadline: null })).toEqual({
      policy: null,
      suggestedRefundMinor: 0,
    });
  });
});
