'use client';

import { useTranslations } from 'next-intl';
import { Fragment, useState, useTransition } from 'react';
import type { DuplicateGuest, Guest, MatchConfidence } from '@/lib/api';
import { findDuplicates, mergeGuest } from '@/app/properties/[propertyId]/guests/actions';
import { formatMoney } from '@/lib/dates';

/**
 * The guest book, with a way to fix the duplicates it shows.
 *
 * The merge panel opens on the row the operator wants to KEEP, and everything
 * in it is worded that way: candidates are folded *into* this profile. The
 * direction decides whose spelling, email and notes lead, and burying that in a
 * dialog with two equal-looking columns is how the wrong one gets picked.
 *
 * Candidates load when the panel opens rather than with the page. Most rows
 * have none, and the query is a self-join nobody should pay for while scrolling.
 */
export function GuestList({
  propertyId,
  guests,
  canMerge,
}: {
  propertyId: string;
  guests: Guest[];
  canMerge: boolean;
}) {
  const t = useTranslations('guests');

  const [openFor, setOpenFor] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DuplicateGuest[]>([]);
  const [confirming, setConfirming] = useState<DuplicateGuest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function togglePanel(guest: Guest) {
    setError(null);
    setOutcome(null);
    setConfirming(null);

    if (openFor === guest.id) {
      setOpenFor(null);
      return;
    }

    setOpenFor(guest.id);
    setCandidates([]);
    startTransition(async () => {
      const result = await findDuplicates(propertyId, guest.id);
      if (!result.ok) {
        setError(result.error?.message ?? t('mergeFailed'));
        return;
      }
      setCandidates(result.items ?? []);
    });
  }

  function confirmMerge(survivor: Guest, duplicate: DuplicateGuest) {
    setError(null);
    startTransition(async () => {
      const result = await mergeGuest(propertyId, survivor.id, duplicate.id);
      if (!result.ok) {
        setError(result.error?.message ?? t('mergeFailed'));
        return;
      }
      setConfirming(null);
      setOpenFor(null);
      setOutcome(
        t('mergeDone', {
          name: displayName(duplicate),
          count: result.merged?.reservationsMoved ?? 0,
        }),
      );
    });
  }

  return (
    <div className="space-y-3">
      {outcome && (
        <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {outcome}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
              <th className="px-3 py-2 font-medium">{t('name')}</th>
              <th className="px-3 py-2 font-medium">{t('contact')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('stays')}</th>
              <th className="px-3 py-2 font-medium">{t('lastStay')}</th>
              <th className="px-3 py-2 text-right font-medium">{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {guests.map((guest) => (
              <Fragment key={guest.id}>
                <tr className="border-b border-stone-100 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink-800">{displayName(guest)}</div>
                    {/* Flagged, never merged: two people can share an address. */}
                    {guest.possibleDuplicates > 0 &&
                      (canMerge ? (
                        <button
                          type="button"
                          onClick={() => togglePanel(guest)}
                          aria-expanded={openFor === guest.id}
                          className="mt-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800 underline-offset-2 hover:underline"
                        >
                          {duplicateLabel(t, guest.possibleDuplicates)}
                        </button>
                      ) : (
                        <span
                          title={t('duplicateHint')}
                          className="mt-0.5 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-800"
                        >
                          {duplicateLabel(t, guest.possibleDuplicates)}
                        </span>
                      ))}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    <div>{guest.email ?? '—'}</div>
                    {guest.phone && <div className="text-xs text-stone-400">{guest.phone}</div>}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-ink-800">{guest.stays}</td>
                  <td className="tabular px-3 py-2 text-stone-600">
                    {guest.lastStay ?? t('never')}
                  </td>
                  <td className="tabular px-3 py-2 text-right text-ink-800">
                    {guest.revenueMinor > 0 ? formatMoney(guest.revenueMinor, 'THB') : '—'}
                  </td>
                </tr>

                {openFor === guest.id && (
                  <tr className="border-b border-stone-100 bg-sunk">
                    <td colSpan={5} className="px-3 py-3">
                      <p className="mb-2 text-sm font-medium text-ink-800">
                        {t('mergeInto', { name: displayName(guest) })}
                      </p>

                      {error && (
                        <p
                          role="alert"
                          className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
                        >
                          {error}
                        </p>
                      )}

                      {pending && candidates.length === 0 && (
                        <p className="text-sm text-stone-500">{t('loading')}</p>
                      )}

                      {!pending && candidates.length === 0 && !error && (
                        <p className="text-sm text-stone-500">{t('noCandidates')}</p>
                      )}

                      <ul className="space-y-2">
                        {candidates.map((candidate) => (
                          <li
                            key={candidate.id}
                            className="flex flex-wrap items-center gap-3 rounded-xl bg-white shadow-card px-3 py-2"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium text-ink-800">
                                {displayName(candidate)}
                              </span>
                              <span className="block text-xs text-stone-500">
                                {[candidate.email, candidate.phone].filter(Boolean).join(' · ') ||
                                  t('noContact')}
                              </span>
                            </span>

                            <ConfidenceBadge confidence={candidate.confidence} t={t} />

                            <span className="text-xs text-stone-500">
                              {candidate.signals.map((signal) => t(`signal${signal}`)).join(', ')}
                            </span>

                            {confirming?.id === candidate.id ? (
                              <span className="flex items-center gap-2">
                                {/* Named in full, because this cannot be undone. */}
                                <span className="text-xs text-ink-700">
                                  {t('mergeConfirm', {
                                    from: displayName(candidate),
                                    into: displayName(guest),
                                  })}
                                </span>
                                <button
                                  type="button"
                                  disabled={pending}
                                  onClick={() => confirmMerge(guest, candidate)}
                                  className="rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
                                >
                                  {t('mergeConfirmYes')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirming(null)}
                                  className="rounded-md border border-stone-300 px-2.5 py-1.5 text-xs text-ink-700 hover:bg-sunk/70"
                                >
                                  {t('cancel')}
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirming(candidate)}
                                className="rounded-md border border-stone-300 px-2.5 py-1.5 text-xs text-ink-700 hover:bg-sunk/70"
                              >
                                {t('mergeAction')}
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfidenceBadge({
  confidence,
  t,
}: {
  confidence: MatchConfidence;
  t: (key: string) => string;
}) {
  // Colour carries the same message as the word, never instead of it: an
  // operator deciding whether two people are one should not be reading hue.
  const tone =
    confidence === 'HIGH'
      ? 'bg-emerald-50 text-emerald-800'
      : confidence === 'MEDIUM'
        ? 'bg-amber-50 text-amber-800'
        : 'bg-sunk text-stone-600';

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {t(`confidence${confidence}`)}
    </span>
  );
}

function displayName(guest: { firstName: string; lastName: string | null }): string {
  return [guest.firstName, guest.lastName].filter(Boolean).join(' ');
}

function duplicateLabel(
  t: (key: string, values?: Record<string, number>) => string,
  count: number,
): string {
  return count === 1 ? t('duplicate', { count }) : t('duplicates', { count });
}
