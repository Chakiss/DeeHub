'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { InventoryGrid as Grid, InventoryDay } from '@/lib/api';
import { addDays, dayLabel, formatMoneyCompact, isWeekend, weekdayLabel } from '@/lib/dates';
import { BulkEditDialog } from './bulk-edit-dialog';

export function InventoryGrid({
  propertyId,
  grid,
  from,
  windowDays,
}: {
  propertyId: string;
  grid: Grid;
  from: string;
  windowDays: number;
}) {
  const t = useTranslations('inventory');
  const [editing, setEditing] = useState(false);

  const dates = grid.roomTypes[0]?.days.map((day) => day.date) ?? [];

  // A grid with no rows renders as a bare header, which is a dead end for a
  // property that has not been set up yet — and says nothing about why it is
  // empty or what to do. Send them where the work actually starts.
  if (grid.roomTypes.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
        <p className="text-sm font-medium text-ink-700">{t('noRoomTypes')}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('noRoomTypesHint')}</p>
        <Link
          href={`/properties/${propertyId}/room-types`}
          className="mt-4 inline-block rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('goToRoomTypes')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`?from=${addDays(from, -windowDays)}`}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70"
        >
          ← {t('previous')}
        </Link>
        <Link
          href={`?from=${addDays(from, windowDays)}`}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70"
        >
          {t('next')} →
        </Link>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="ml-auto rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          {t('edit')}
        </button>
      </div>

      {/* Horizontal scrolling stays INSIDE the grid: the page body must never
          scroll sideways, or the header and nav drift off screen. */}
      <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {/* Sticky so the room type stays readable while scanning 90 days. */}
              <th className="sticky left-0 z-10 min-w-[180px] border-b border-r border-stone-200 bg-sunk px-3 py-2 text-left font-medium text-stone-600">
                {t('roomType')}
              </th>
              {dates.map((date) => (
                <th
                  key={date}
                  className={`min-w-[68px] border-b border-stone-200 px-1 py-2 text-center font-medium ${
                    isWeekend(date) ? 'bg-sunk text-ink-700' : 'bg-sunk text-stone-600'
                  }`}
                >
                  <div className="text-[11px] uppercase tracking-wide text-stone-400">
                    {weekdayLabel(date)}
                  </div>
                  <div className="tabular text-xs">{dayLabel(date)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.roomTypes.map((row) => (
              <tr key={row.roomTypeId} className="group">
                <th className="sticky left-0 z-10 border-b border-r border-stone-200 bg-white px-3 py-2 text-left font-medium text-ink-800 group-hover:bg-sunk/70">
                  <div>{row.name}</div>
                  <div className="text-xs font-normal text-stone-400">{row.code}</div>
                </th>
                {row.days.map((day) => (
                  <Cell key={day.date} day={day} />
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <OccupancyRow grid={grid} dates={dates} />
          </tfoot>
        </table>
      </div>

      <Legend currency={currencyOf(grid)} />

      {editing && (
        <BulkEditDialog
          propertyId={propertyId}
          roomTypes={grid.roomTypes.map((row) => ({ id: row.roomTypeId, name: row.name }))}
          defaultFrom={from}
          defaultTo={addDays(from, windowDays)}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function Cell({ day }: { day: InventoryDay }) {
  const t = useTranslations('inventory');

  if (!day.open) {
    // A night with no row is CLOSED, not empty. Rendering it blank is how a
    // hotel comes to believe it is selling dates it never opened.
    return (
      <td
        title={t('notOpen')}
        className="border-b border-stone-100 bg-sunk px-1 py-2 text-center text-stone-400"
      >
        <span className="tabular text-xs">—</span>
      </td>
    );
  }

  const soldOut = day.available === 0;
  const tight = !soldOut && day.available <= 2;
  // Rooms to sell and no price to sell them at. Every other screen shows this
  // night as bookable; it fails only when a guest tries.
  const unsellable = day.allotment > 0 && day.rate === null;

  const tooltip = [
    `${t('allotment')} ${String(day.allotment)}`,
    `${t('booked')} ${String(day.booked)}`,
    day.rate
      ? `${t('rate')} ${formatMoneyCompact(day.rate.amountMinor)} ${day.rate.currency}`
      : t('noRateWarning'),
    day.rate && day.rate.planCount > 1
      ? t('plansPriced', { count: day.rate.planCount })
      : undefined,
    day.stopSell ? t('stopSell') : undefined,
    day.minStay > 1 ? `${t('minStay')} ${String(day.minStay)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <td
      title={tooltip}
      className={`border-b border-stone-100 px-1 py-1.5 text-center ${
        day.stopSell
          ? 'bg-rose-50'
          : unsellable
            ? 'bg-orange-50'
            : soldOut
              ? 'bg-amber-50'
              : isWeekend(day.date)
                ? 'bg-sunk/60'
                : ''
      }`}
    >
      <div
        className={`tabular text-sm font-medium leading-tight ${
          soldOut ? 'text-amber-700' : tight ? 'text-orange-600' : 'text-ink-800'
        }`}
      >
        {day.available}
      </div>
      <div className="tabular text-[10px] leading-tight text-stone-400">
        {day.booked}/{day.allotment}
      </div>

      {/* Price in the same cell as availability, so "can I sell it" and "for
          how much" are one glance rather than two rows apart. */}
      {day.rate ? (
        <div className="tabular text-[11px] leading-tight text-stone-600">
          {formatMoneyCompact(day.rate.amountMinor)}
          {day.rate.planCount > 1 && <span className="text-stone-300"> +</span>}
        </div>
      ) : (
        <div
          className={`text-[10px] leading-tight ${
            unsellable ? 'font-medium text-orange-700' : 'text-stone-300'
          }`}
        >
          {t('noRate')}
        </div>
      )}

      {(day.stopSell || day.minStay > 1) && (
        <div className="mt-0.5 flex justify-center gap-0.5">
          {day.stopSell && <Badge tone="rose">×</Badge>}
          {day.minStay > 1 && <Badge tone="slate">{day.minStay}</Badge>}
        </div>
      )}
    </td>
  );
}

/**
 * Occupancy across the room types currently shown.
 *
 * Sold over allotment, not over physical rooms: allotment is what the property
 * chose to sell that night, so it is the number the percentage should be
 * measured against (ADR-0002).
 */
function OccupancyRow({ grid, dates }: { grid: Grid; dates: string[] }) {
  const t = useTranslations('inventory');

  return (
    <tr className="border-t-2 border-stone-200 bg-sunk">
      <th className="sticky left-0 z-10 border-r border-stone-200 bg-sunk px-3 py-2 text-left text-xs font-medium text-stone-600">
        {t('occupancy')}
      </th>
      {dates.map((date, index) => {
        let booked = 0;
        let allotment = 0;
        for (const row of grid.roomTypes) {
          const day = row.days[index];
          if (day?.open) {
            booked += day.booked;
            allotment += day.allotment;
          }
        }

        // No allotment is not 0% occupancy — nothing was offered, so there is
        // no ratio to report.
        const percent = allotment === 0 ? null : Math.round((booked / allotment) * 100);

        return (
          <td key={date} className="px-1 py-2 text-center align-bottom">
            {percent === null ? (
              <span className="text-[10px] text-stone-300">—</span>
            ) : (
              <>
                <div className="mx-auto h-1 w-8 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className={`h-full ${percent >= 90 ? 'bg-amber-500' : 'bg-brand-500'}`}
                    style={{ width: `${String(Math.min(percent, 100))}%` }}
                  />
                </div>
                <div className="tabular mt-0.5 text-[10px] text-stone-500">{percent}%</div>
                <div className="tabular text-[9px] text-stone-400">
                  {booked}/{allotment}
                </div>
              </>
            )}
          </td>
        );
      })}
    </tr>
  );
}

function Badge({ tone, children }: { tone: 'rose' | 'slate'; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded px-1 text-[9px] font-semibold leading-none ${
        tone === 'rose' ? 'bg-rose-200 text-rose-800' : 'bg-stone-200 text-ink-700'
      }`}
    >
      {children}
    </span>
  );
}

function Legend({ currency }: { currency: string | null }) {
  const t = useTranslations('inventory');
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-stone-500">
      <LegendItem className="bg-amber-50 text-amber-700">0</LegendItem>
      <span>{t('available')} 0</span>
      <LegendItem className="bg-rose-50 text-rose-700">×</LegendItem>
      <span>{t('stopSell')}</span>
      <LegendItem className="bg-sunk text-stone-400">—</LegendItem>
      <span>{t('notOpen')}</span>
      <LegendItem className="bg-orange-50 text-orange-700">!</LegendItem>
      <span>{t('noRateWarning')}</span>
      {/* Stated once here rather than repeated in every cell. */}
      {currency && <span className="ml-auto">{t('pricesIn', { currency })}</span>}
    </div>
  );
}

/** The property's currency, read off the first priced night in the grid. */
function currencyOf(grid: Grid): string | null {
  for (const row of grid.roomTypes) {
    for (const day of row.days) {
      if (day.rate) return day.rate.currency;
    }
  }
  return null;
}

function LegendItem({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 w-6 items-center justify-center rounded border border-stone-200 text-[10px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}
