import { describe, expect, it } from 'vitest';
import { toIsoDate } from '@deehub/shared';
import { buildCashBook, type CashMovement } from './cash-book';

const THB = 'THB';
const FROM = toIsoDate('2026-08-01');
const TO = toIsoDate('2026-09-01');

function movement(partial: Partial<CashMovement> & Pick<CashMovement, 'direction'>): CashMovement {
  return {
    date: toIsoDate('2026-08-01'),
    description: 'x',
    amountMinor: 100_000,
    reference: null,
    source: partial.direction === 'IN' ? 'FOLIO_PAYMENT' : 'EXPENSE',
    sourceId: 'a',
    ...partial,
  };
}

describe('buildCashBook()', () => {
  it('numbers the lines from one, because the book is read on paper', () => {
    const book = buildCashBook(
      [movement({ direction: 'IN', sourceId: 'a' }), movement({ direction: 'OUT', sourceId: 'b' })],
      THB,
      FROM,
      TO,
    );
    expect(book.rows.map((row) => row.seq)).toEqual([1, 2]);
  });

  it('runs the balance forward line by line', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'IN', date: toIsoDate('2026-08-01'), amountMinor: 500_000 }),
        movement({ direction: 'OUT', date: toIsoDate('2026-08-02'), amountMinor: 200_000 }),
        movement({ direction: 'IN', date: toIsoDate('2026-08-03'), amountMinor: 50_000 }),
      ],
      THB,
      FROM,
      TO,
    );
    expect(book.rows.map((row) => row.balance.amount)).toEqual([500_000, 300_000, 350_000]);
    expect(book.closingBalance.amount).toBe(350_000);
  });

  /** How a cash book is read and counted: takings first, then what went out. */
  it('lists a day’s receipts before its payments', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'OUT', amountMinor: 200_000, sourceId: 'b' }),
        movement({ direction: 'IN', amountMinor: 500_000, sourceId: 'a' }),
      ],
      THB,
      FROM,
      TO,
    );
    expect(book.rows.map((row) => row.received.amount)).toEqual([500_000, 0]);
    expect(book.rows.map((row) => row.paid.amount)).toEqual([0, 200_000]);
  });

  it('carries an opening balance so the closing figure matches a bank account', () => {
    const book = buildCashBook(
      [movement({ direction: 'IN', amountMinor: 100_000 })],
      THB,
      FROM,
      TO,
      2_500_000,
    );
    expect(book.openingBalance.amount).toBe(2_500_000);
    expect(book.rows[0]?.balance.amount).toBe(2_600_000);
    expect(book.closingBalance.amount).toBe(2_600_000);
  });

  /**
   * The mistake this guards: netting a refund against the day's takings makes
   * "received" a net figure that hides both sides, and the owner counting a
   * drawer needs them apart.
   */
  it('records a refund as money out, not as a smaller receipt', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'IN', amountMinor: 300_000, sourceId: 'a' }),
        movement({
          direction: 'OUT',
          source: 'FOLIO_REFUND',
          amountMinor: 100_000,
          sourceId: 'b',
        }),
      ],
      THB,
      FROM,
      TO,
    );
    expect(book.totalReceived.amount).toBe(300_000);
    expect(book.totalPaid.amount).toBe(100_000);
    expect(book.closingBalance.amount).toBe(200_000);
  });

  it('puts each amount in exactly one column', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'IN', date: toIsoDate('2026-08-01'), amountMinor: 111 }),
        movement({ direction: 'OUT', date: toIsoDate('2026-08-02'), amountMinor: 222 }),
      ],
      THB,
      FROM,
      TO,
    );
    expect(book.rows[0]?.received.amount).toBe(111);
    expect(book.rows[0]?.paid.amount).toBe(0);
    expect(book.rows[1]?.received.amount).toBe(0);
    expect(book.rows[1]?.paid.amount).toBe(222);
  });

  it('has totals that reconcile with the closing balance', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'IN', amountMinor: 987_654, sourceId: 'a' }),
        movement({ direction: 'OUT', amountMinor: 123_456, sourceId: 'b' }),
        movement({ direction: 'OUT', amountMinor: 1, sourceId: 'c' }),
      ],
      THB,
      FROM,
      TO,
      10_000,
    );
    expect(book.closingBalance.amount).toBe(
      book.openingBalance.amount + book.totalReceived.amount - book.totalPaid.amount,
    );
  });

  it('goes negative rather than clamping when more went out than came in', () => {
    const book = buildCashBook(
      [movement({ direction: 'OUT', amountMinor: 500_000 })],
      THB,
      FROM,
      TO,
    );
    expect(book.closingBalance.amount).toBe(-500_000);
  });
});

describe('ordering', () => {
  it('sorts by date regardless of the order rows arrived in', () => {
    const book = buildCashBook(
      [
        movement({ direction: 'IN', date: toIsoDate('2026-08-20'), sourceId: 'c' }),
        movement({ direction: 'IN', date: toIsoDate('2026-08-02'), sourceId: 'a' }),
        movement({ direction: 'IN', date: toIsoDate('2026-08-11'), sourceId: 'b' }),
      ],
      THB,
      FROM,
      TO,
    );
    expect(book.rows.map((row) => row.date)).toEqual(['2026-08-02', '2026-08-11', '2026-08-20']);
  });

  /**
   * A report that will not reproduce itself is not evidence. Two runs over the
   * same rows, delivered in different orders, must print the same balances.
   */
  it('produces the same book whatever order the movements arrive in', () => {
    const movements: CashMovement[] = [
      movement({ direction: 'IN', date: toIsoDate('2026-08-05'), amountMinor: 100, sourceId: 'x' }),
      movement({
        direction: 'OUT',
        date: toIsoDate('2026-08-05'),
        amountMinor: 200,
        sourceId: 'y',
      }),
      movement({ direction: 'IN', date: toIsoDate('2026-08-05'), amountMinor: 300, sourceId: 'z' }),
      movement({
        direction: 'OUT',
        date: toIsoDate('2026-08-04'),
        amountMinor: 400,
        sourceId: 'w',
      }),
    ];
    const forward = buildCashBook(movements, THB, FROM, TO);
    const reversed = buildCashBook([...movements].reverse(), THB, FROM, TO);
    const shuffled = buildCashBook(
      [movements[2], movements[0], movements[3], movements[1]].filter(
        (m): m is CashMovement => m !== undefined,
      ),
      THB,
      FROM,
      TO,
    );

    expect(reversed.rows).toEqual(forward.rows);
    expect(shuffled.rows).toEqual(forward.rows);
  });
});

describe('an empty period', () => {
  it('still reports the opening balance as the closing one', () => {
    const book = buildCashBook([], THB, FROM, TO, 750_000);
    expect(book.rows).toHaveLength(0);
    expect(book.totalReceived.amount).toBe(0);
    expect(book.totalPaid.amount).toBe(0);
    expect(book.closingBalance.amount).toBe(750_000);
  });
});
