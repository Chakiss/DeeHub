'use client';

import { useTranslations } from 'next-intl';
import { useState, useTransition, type FormEvent } from 'react';
import type { BookingSource } from '@/lib/api';
import {
  addDefaultBookingSources,
  createBookingSource,
  updateBookingSource,
} from '@/app/properties/[propertyId]/booking-sources/actions';

const KINDS = ['OTA', 'TRAVEL_AGENT'] as const;

/**
 * Where this property's bookings come from: the OTAs it sells through and
 * the agents it has contracts with, as the list the booking form offers.
 *
 * A source is retired, never deleted — bookings point at it and reports
 * group by it — and its kind never changes, because every booking that named
 * it recorded its category from it.
 */
export function BookingSourceList({
  propertyId,
  sources,
  canEdit,
}: {
  propertyId: string;
  sources: BookingSource[];
  canEdit: boolean;
}) {
  const t = useTranslations('bookingSources');

  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(source: BookingSource) {
    setError(null);
    startTransition(async () => {
      const result = await updateBookingSource(propertyId, source.id, {
        isActive: !source.isActive,
      });
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  function addDefaults() {
    setError(null);
    startTransition(async () => {
      const result = await addDefaultBookingSources(propertyId);
      if (!result.ok) setError(result.error?.message ?? t('failed'));
    });
  }

  return (
    <div className="space-y-3">
      <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800">{t('notChannels')}</p>

      {canEdit && (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={addDefaults}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
          >
            {t('addDefaults')}
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            {t('add')}
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {sources.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-ink-700">{t('empty')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-stone-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-stone-200/70 bg-white shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
                <th className="px-3 py-2 font-medium">{t('name')}</th>
                <th className="px-3 py-2 font-medium">{t('kind')}</th>
                <th className="px-3 py-2 font-medium">{t('status')}</th>
                {canEdit && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr
                  key={source.id}
                  className={`border-b border-stone-100 last:border-0 ${
                    source.isActive ? '' : 'bg-sunk/60 text-stone-400'
                  }`}
                >
                  <td className="px-3 py-2 font-medium text-ink-800">
                    {source.name}
                    {source.channelType && (
                      <span
                        title={t('linkedToConnector')}
                        className="ml-2 rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-normal text-sky-700"
                      >
                        {t('connector')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-stone-600">{t(`kind${source.kind}`)}</td>
                  <td className="px-3 py-2 text-stone-600">
                    {source.isActive ? t('inUse') : t('retired')}
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => toggle(source)}
                        className="rounded-md border border-stone-300 px-2 py-1 text-xs text-ink-700 hover:bg-sunk/70 disabled:opacity-60"
                      >
                        {source.isActive ? t('retire') : t('reinstate')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && sources.length > 0 && <p className="text-xs text-stone-400">{t('noDelete')}</p>}

      {adding && <AddSourceDialog propertyId={propertyId} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSourceDialog({ propertyId, onClose }: { propertyId: string; onClose: () => void }) {
  const t = useTranslations('bookingSources');

  const [name, setName] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('TRAVEL_AGENT');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    const result = await createBookingSource(propertyId, { name, kind });
    setSaving(false);
    if (!result.ok) {
      setError(
        result.error?.code === 'CONFLICT' ? t('nameTaken') : (result.error?.message ?? t('failed')),
      );
      return;
    }
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('add')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-stone-200/70 bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">{t('add')}</h2>

        <div>
          <label htmlFor="source-name" className="mb-1 block text-sm font-medium text-ink-700">
            {t('name')}
          </label>
          <input
            id="source-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
            autoFocus
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
            placeholder={t('namePlaceholder')}
          />
        </div>

        <div>
          <label htmlFor="source-kind" className="mb-1 block text-sm font-medium text-ink-700">
            {t('kind')}
          </label>
          <select
            id="source-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {KINDS.map((option) => (
              <option key={option} value={option}>
                {t(`kind${option}`)}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-stone-400">{t('kindHint')}</p>
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm text-ink-700 hover:bg-sunk/70"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  );
}
