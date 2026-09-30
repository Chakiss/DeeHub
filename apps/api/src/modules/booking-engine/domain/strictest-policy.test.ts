import { describe, expect, it } from 'vitest';
import { policyOf, strictestPolicy } from './strictest-policy';

describe('strictestPolicy', () => {
  it('is null for no stays at all', () => {
    expect(strictestPolicy([])).toBeNull();
  });

  it('is the only stay policy when there is one', () => {
    expect(strictestPolicy([{ noticeHours: 24, refundPercent: 50 }])).toEqual({
      noticeHours: 24,
      refundPercent: 50,
    });
  });

  it('lets the lowest refund win, whatever its notice', () => {
    expect(
      strictestPolicy([
        { noticeHours: 72, refundPercent: 100 },
        { noticeHours: 24, refundPercent: 50 },
      ]),
    ).toEqual({ noticeHours: 24, refundPercent: 50 });
  });

  it('breaks a tie with the longest notice', () => {
    expect(
      strictestPolicy([
        { noticeHours: 24, refundPercent: 50 },
        { noticeHours: 48, refundPercent: 50 },
        { noticeHours: 12, refundPercent: 50 },
      ]),
    ).toEqual({ noticeHours: 48, refundPercent: 50 });
  });

  it('never blends two stays into a policy neither has', () => {
    const result = strictestPolicy([
      { noticeHours: 72, refundPercent: 50 },
      { noticeHours: 24, refundPercent: 0 },
    ]);
    expect(result).toEqual({ noticeHours: 24, refundPercent: 0 });
  });

  it('is null when any stay has no recorded policy', () => {
    expect(strictestPolicy([{ noticeHours: 24, refundPercent: 50 }, null])).toBeNull();
    expect(strictestPolicy([null, { noticeHours: 24, refundPercent: 50 }])).toBeNull();
  });
});

describe('policyOf', () => {
  it('reads a column pair, and is null unless both are present', () => {
    expect(policyOf({ cancellationNoticeHours: 24, cancellationRefundPercent: 50 })).toEqual({
      noticeHours: 24,
      refundPercent: 50,
    });
    expect(policyOf({ cancellationNoticeHours: null, cancellationRefundPercent: null })).toBeNull();
    expect(policyOf({ cancellationNoticeHours: 24, cancellationRefundPercent: null })).toBeNull();
  });
});
