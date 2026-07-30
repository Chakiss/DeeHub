'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { InventoryGrid as Grid, InventoryDay } from '@/lib/api';
import { addDays, dayLabel, isWeekend, weekdayLabel } from '@/lib/dates';
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`?from=${addDays(from, -windowDays)}`}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          ← {t('previous')}
        </Link>
        <Link
          href={`?from=${addDays(from, windowDays)}`}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
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
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {/* Sticky so the room type stays readable while scanning 90 days. */}
              <th className="sticky left-0 z-10 min-w-[180px] border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-slate-600">
                {t('roomType')}
              </th>
              {dates.map((date) => (
                <th
                  key={date}
                  className={`min-w-[62px] border-b border-slate-200 px-1 py-2 text-center font-medium ${
                    isWeekend(date) ? 'bg-slate-100 text-slate-700' : 'bg-slate-50 text-slate-600'
                  }`}
                >
                  <div className="text-[11px] uppercase tracking-wide text-slate-400">
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
                <th className="sticky left-0 z-10 border-b border-r border-slate-200 bg-white px-3 py-2 text-left font-medium text-slate-800 group-hover:bg-slate-50">
                  <div>{row.name}</div>
                  <div className="text-xs font-normal text-slate-400">{row.code}</div>
                </th>
                {row.days.map((day) => (
                  <Cell key={day.date} day={day} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Legend />

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
        className="border-b border-slate-100 bg-slate-100 px-1 py-2 text-center text-slate-400"
      >
        <span className="tabular text-xs">—</span>
      </td>
    );
  }

  const soldOut = day.available === 0;
  const tight = !soldOut && day.available <= 2;

  return (
    <td
      title={`${t('allotment')} ${String(day.allotment)} · ${t('booked')} ${String(day.booked)}${
        day.stopSell ? ` · ${t('stopSell')}` : ''
      }${day.minStay > 1 ? ` · ${t('minStay')} ${String(day.minStay)}` : ''}`}
      className={`border-b border-slate-100 px-1 py-2 text-center ${
        day.stopSell
          ? 'bg-rose-50'
          : soldOut
            ? 'bg-amber-50'
            : isWeekend(day.date)
              ? 'bg-slate-50/60'
              : ''
      }`}
    >
      <div
        className={`tabular text-sm font-medium ${
          soldOut ? 'text-amber-700' : tight ? 'text-orange-600' : 'text-slate-800'
        }`}
      >
        {day.available}
      </div>
      <div className="tabular text-[10px] text-slate-400">
        {day.booked}/{day.allotment}
      </div>
      {(day.stopSell || day.minStay > 1) && (
        <div className="mt-0.5 flex justify-center gap-0.5">
          {day.stopSell && <Badge tone="rose">×</Badge>}
          {day.minStay > 1 && <Badge tone="slate">{day.minStay}</Badge>}
        </div>
      )}
    </td>
  );
}

function Badge({ tone, children }: { tone: 'rose' | 'slate'; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-3.5 min-w-3.5 items-center justify-center rounded px-1 text-[9px] font-semibold leading-none ${
        tone === 'rose' ? 'bg-rose-200 text-rose-800' : 'bg-slate-200 text-slate-700'
      }`}
    >
      {children}
    </span>
  );
}

function Legend() {
  const t = useTranslations('inventory');
  return (
    <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
      <LegendItem className="bg-amber-50 text-amber-700">0</LegendItem>
      <span>{t('available')} 0</span>
      <LegendItem className="bg-rose-50 text-rose-700">×</LegendItem>
      <span>{t('stopSell')}</span>
      <LegendItem className="bg-slate-100 text-slate-400">—</LegendItem>
      <span>{t('notOpen')}</span>
    </div>
  );
}

function LegendItem({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex h-5 w-6 items-center justify-center rounded border border-slate-200 text-[10px] font-medium ${className}`}
    >
      {children}
    </span>
  );
}
