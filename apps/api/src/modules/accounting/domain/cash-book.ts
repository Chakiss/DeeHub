import { money, type IsoDate, type Money } from '@deehub/shared';

/**
 * รายงานเงินสดรับ-จ่าย — money in, money out, day by day.
 *
 * Not a convenience view. An individual taxpayer with เงินได้ตามมาตรา 40(8) —
 * which is what a hotel owner trading in their own name has — is required to
 * keep this book, and it is the primary supporting record behind ภ.ง.ด.90/94.
 * For a property that is not VAT registered it is very nearly the whole of
 * what the Revenue Department wants to see.
 *
 * **It records what moved, not what was owed.** Two consequences that are easy
 * to get wrong:
 *
 * - A refund is money going OUT. Recorded as a negative receipt it would net
 *   against the day's takings and hide both, which is the same reason
 *   `folio_payments` keeps PAYMENT and REFUND apart as positive amounts.
 * - An expense contributes the amount actually paid to the supplier, **net of
 *   anything withheld**. Tax withheld has not left the hotel's hands yet; it
 *   leaves later, when it is remitted, and that remittance is its own entry.
 *   Recording the gross here would take the same baht out of the bank twice.
 */

export const CASH_SOURCES = ['FOLIO_PAYMENT', 'FOLIO_REFUND', 'REVENUE_ENTRY', 'EXPENSE'] as const;
export type CashSource = (typeof CASH_SOURCES)[number];

export interface CashMovement {
  readonly date: IsoDate;
  readonly direction: 'IN' | 'OUT';
  readonly description: string;
  /** Always positive. Direction says which way it went. */
  readonly amountMinor: number;
  readonly reference: string | null;
  readonly source: CashSource;
  /** Stable tiebreak within a day — the id of the underlying row. */
  readonly sourceId: string;
}

export interface CashBookRow {
  /** Line number within the report, from 1. The book is read on paper. */
  readonly seq: number;
  readonly date: IsoDate;
  readonly description: string;
  readonly reference: string | null;
  readonly source: CashSource;
  readonly received: Money;
  readonly paid: Money;
  /** Running balance after this line. */
  readonly balance: Money;
}

export interface CashBook {
  readonly currency: string;
  readonly from: IsoDate;
  /** Exclusive, matching every other range in this system. */
  readonly to: IsoDate;
  readonly openingBalance: Money;
  readonly rows: readonly CashBookRow[];
  readonly totalReceived: Money;
  readonly totalPaid: Money;
  readonly closingBalance: Money;
}

/**
 * Build the book from movements someone else has loaded.
 *
 * `openingBalance` is everything that moved before `from`, computed by the
 * query rather than here — a report starting mid-year with a balance of zero
 * would show a closing figure that matches no bank account.
 *
 * Within a day, receipts are listed before payments — the order a cash book is
 * conventionally read and counted in — and ties are broken by source and then
 * id. The tiebreak is not cosmetic: without a total order the running balance
 * column changes between two runs over the same rows, and a book that will not
 * reproduce itself is not evidence of anything.
 */
export function buildCashBook(
  movements: readonly CashMovement[],
  currency: string,
  from: IsoDate,
  to: IsoDate,
  openingBalanceMinor = 0,
): CashBook {
  const directionRank = (movement: CashMovement): number => (movement.direction === 'IN' ? 0 : 1);

  const ordered = [...movements].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      directionRank(a) - directionRank(b) ||
      a.source.localeCompare(b.source) ||
      a.sourceId.localeCompare(b.sourceId),
  );

  const rows: CashBookRow[] = [];
  let balance = openingBalanceMinor;
  let received = 0;
  let paid = 0;

  for (const [index, movement] of ordered.entries()) {
    const isIn = movement.direction === 'IN';
    if (isIn) {
      received += movement.amountMinor;
      balance += movement.amountMinor;
    } else {
      paid += movement.amountMinor;
      balance -= movement.amountMinor;
    }

    rows.push({
      seq: index + 1,
      date: movement.date,
      description: movement.description,
      reference: movement.reference,
      source: movement.source,
      received: money(isIn ? movement.amountMinor : 0, currency),
      paid: money(isIn ? 0 : movement.amountMinor, currency),
      balance: money(balance, currency),
    });
  }

  return {
    currency,
    from,
    to,
    openingBalance: money(openingBalanceMinor, currency),
    rows,
    totalReceived: money(received, currency),
    totalPaid: money(paid, currency),
    closingBalance: money(balance, currency),
  };
}
