'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { Guest } from '@/lib/api';
import { searchGuests } from '@/app/properties/[propertyId]/guests/actions';

export function guestDisplayName(guest: Pick<Guest, 'firstName' | 'lastName'>): string {
  return [guest.firstName, guest.lastName].filter(Boolean).join(' ');
}

/**
 * "Returning guest": pick someone who has stayed before instead of typing
 * them in again.
 *
 * The point is not the typing saved but the link: a booking made this way
 * carries the profile's id, so the stay lands on the same person — their
 * count, their revenue, their notes — instead of creating a near-duplicate
 * that somebody later has to merge. The picker searches the same endpoint
 * the guests screen does, so it finds exactly whom that screen would.
 */
export function GuestPicker({
  propertyId,
  selected,
  open,
  onOpen,
  onClose,
  onPick,
  onClear,
}: {
  propertyId: string;
  selected: Guest | null;
  /** The search panel is open. Owned by the form so it can place the button and the panel apart. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (guest: Guest) => void;
  onClear: () => void;
}) {
  const t = useTranslations('reservations');
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Guest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Searched as typed, a beat after the last keystroke: two characters is
  // enough to be useful for a phone number and short enough for a Thai name.
  useEffect(() => {
    if (!open) return;
    const query = term.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchGuests(propertyId, query).then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(result.error?.message ?? null);
          setResults([]);
          return;
        }
        setError(null);
        setResults(result.items ?? []);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, term, propertyId]);

  if (selected) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
        <span className="font-medium">{t('returningGuest')}:</span>
        <span>{guestDisplayName(selected)}</span>
        <span className="text-xs text-emerald-700">
          {t('guestStays', { count: selected.stays })}
          {selected.lastStay ? ` · ${t('guestLastStay', { date: selected.lastStay })}` : ''}
        </span>
        <button
          type="button"
          onClick={() => {
            onClear();
            setTerm('');
            setResults(null);
          }}
          className="ml-auto rounded px-2 py-0.5 text-xs text-emerald-800 hover:bg-emerald-100"
        >
          {t('unlinkGuest')}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
      >
        {t('returningGuest')}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-stone-300 bg-sunk p-3">
      <div className="flex items-center gap-2">
        <input
          type="search"
          autoFocus
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder={t('searchGuests')}
          aria-label={t('searchGuests')}
          className="w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900"
        />
        <button
          type="button"
          onClick={() => {
            onClose();
            setTerm('');
            setResults(null);
          }}
          className="shrink-0 text-xs text-stone-500 hover:text-ink-800"
        >
          {t('closePicker')}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-rose-700">
          {error}
        </p>
      )}
      {results !== null && results.length === 0 && !error && (
        <p className="text-xs text-stone-500">{t('noGuestsFound')}</p>
      )}
      {results && results.length > 0 && (
        <ul className="max-h-64 divide-y divide-stone-200 overflow-y-auto rounded-md border border-stone-200 bg-white">
          {results.map((guest) => (
            <li key={guest.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(guest);
                  setTerm('');
                  setResults(null);
                }}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-sunk/70"
              >
                <span className="font-medium text-ink-900">{guestDisplayName(guest)}</span>
                <span className="text-xs text-stone-500">
                  {[guest.phone, guest.email].filter(Boolean).join(' · ')}
                </span>
                <span className="ml-auto text-xs text-stone-500">
                  {t('guestStays', { count: guest.stays })}
                  {guest.lastStay ? ` · ${guest.lastStay}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
