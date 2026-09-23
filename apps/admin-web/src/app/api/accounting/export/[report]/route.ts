import { NextResponse, type NextRequest } from 'next/server';
import { api, ApiError } from '@/lib/api';

/**
 * Reports as CSV, for the accountant who wants them in a spreadsheet.
 *
 * A route handler rather than an `api.*` method because `lib/api.ts` parses
 * JSON and returns objects; this has to return a file. It runs on the server
 * side of the BFF, so the browser still never sees the DeeHub token.
 */

const REPORTS = ['expenses', 'cash-book'] as const;
type Report = (typeof REPORTS)[number];

function isReport(value: string): value is Report {
  return (REPORTS as readonly string[]).includes(value);
}

/**
 * Quote a CSV field.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a quote as well. Excel treats
 * those as formulas, so a supplier called "-Somchai" or a note starting with
 * "=" would execute rather than display — the injection everyone forgets about
 * because it is the spreadsheet doing it, not the site.
 */
function csvField(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function toCsv(header: readonly string[], rows: readonly (string | number | null)[][]): string {
  const body = [header.map(csvField).join(','), ...rows.map((row) => row.map(csvField).join(','))];
  /*
   * The BOM is not optional. Without it Excel on Windows reads the file as the
   * system code page and every Thai character in it becomes garbage — which is
   * exactly the audience this export exists for. CRLF for the same reason.
   */
  return `﻿${body.join('\r\n')}\r\n`;
}

/** Baht for a spreadsheet: satang are an implementation detail. */
function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ report: string }> },
) {
  const { report } = await params;
  const search = request.nextUrl.searchParams;
  const propertyId = search.get('propertyId');
  const from = search.get('from');
  const to = search.get('to');

  if (!isReport(report) || !propertyId || !from || !to) {
    return NextResponse.json({ error: 'propertyId, from and to are required' }, { status: 400 });
  }

  try {
    const { filename, csv } =
      report === 'expenses'
        ? await expensesCsv(propertyId, from, to)
        : await cashBookCsv(propertyId, from, to);

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        // A financial report is a snapshot of a moment; a cached copy served
        // after a correction is worse than a slow one.
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: 'Export failed' }, { status: 500 });
  }
}

async function expensesCsv(propertyId: string, from: string, to: string) {
  const expenses = await api.expenses(propertyId, from, to, { basis: 'ACCRUAL' });
  return {
    filename: `expenses-${from}-${to}.csv`,
    csv: toCsv(
      [
        'วันที่ใบกำกับ',
        'รายการ',
        'หมวด',
        'ผู้ขาย',
        'เลขที่ใบกำกับ',
        'มูลค่าก่อนภาษี',
        'ภาษีมูลค่าเพิ่ม',
        'รวม',
        'หัก ณ ที่จ่าย',
        'จ่ายจริง',
        'วันที่จ่าย',
        'งวดภาษีซื้อ',
      ],
      expenses.map((expense) => [
        expense.expenseDate,
        expense.description,
        expense.categoryNameTh,
        expense.vendorName,
        expense.supplierDocNumber,
        major(expense.net.amount),
        major(expense.vat.amount),
        major(expense.gross.amount),
        major(expense.wht.amount),
        major(expense.paid.amount),
        expense.paidDate,
        expense.vatClaimedPeriod,
      ]),
    ),
  };
}

async function cashBookCsv(propertyId: string, from: string, to: string) {
  const book = await api.cashBook(propertyId, from, to);
  return {
    filename: `cash-book-${from}-${to}.csv`,
    csv: toCsv(
      ['ลำดับ', 'วันที่', 'รายการ', 'อ้างอิง', 'รายรับ', 'รายจ่าย', 'คงเหลือ'],
      [
        // The opening balance is a row, not a footnote: a book whose first line
        // is not the balance brought forward does not tie to a bank statement.
        ['', from, 'ยอดยกมา', '', '', '', major(book.openingBalance.amount)],
        ...book.items.map((row) => [
          row.seq,
          row.date,
          row.description,
          row.reference,
          row.received.amount === 0 ? '' : major(row.received.amount),
          row.paid.amount === 0 ? '' : major(row.paid.amount),
          major(row.balance.amount),
        ]),
        [
          '',
          '',
          'รวม',
          '',
          major(book.totalReceived.amount),
          major(book.totalPaid.amount),
          major(book.closingBalance.amount),
        ],
      ],
    ),
  };
}
