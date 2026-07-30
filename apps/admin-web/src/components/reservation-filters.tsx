'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

const STATUSES = [
  'CONFIRMED',
  'PENDING',
  'CHECKED_IN',
  'CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
] as const;

export function ReservationFilters({
  searchPlaceholder,
  allStatusesLabel,
  defaultQuery,
  defaultStatus,
}: {
  searchPlaceholder: string;
  allStatusesLabel: string;
  defaultQuery: string;
  defaultStatus: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(defaultQuery);

  function apply(next: { q?: string; status?: string }) {
    const search = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    // A filter change invalidates the cursor: keeping it would page into a
    // different result set and silently skip rows.
    search.delete('cursor');
    router.push(`?${search.toString()}`);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    apply({ q: query });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={searchPlaceholder}
        className="min-w-[280px] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
      <select
        defaultValue={defaultStatus}
        onChange={(event) => apply({ status: event.target.value })}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700"
      >
        <option value="">{allStatusesLabel}</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {status.replace('_', ' ').toLowerCase()}
          </option>
        ))}
      </select>
    </form>
  );
}
