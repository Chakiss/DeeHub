'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import { CHANNEL_TYPES, type ChannelType } from '@/lib/channel-types';
import { createChannel } from '@/app/properties/[propertyId]/channels/actions';

/**
 * Create a channel.
 *
 * Deliberately minimal: type, name and horizon. Credentials and mappings are
 * entered on the detail screen, because a channel is useless until it is mapped
 * and this form should not imply otherwise by asking for a password up front.
 */
export function ChannelCreateForm({ propertyId }: { propertyId: string }) {
  const t = useTranslations('channels');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [type, setType] = useState<ChannelType>('MOCK_OTA');
  const [name, setName] = useState('');
  const [horizon, setHorizon] = useState(365);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    if (!name.trim()) {
      setError(t('nameRequired'));
      return;
    }
    startTransition(async () => {
      const result = await createChannel(propertyId, {
        type,
        name: name.trim(),
        syncHorizonDays: horizon,
      });
      if (result.ok && result.channelId) {
        setOpen(false);
        setName('');
        router.push(`/properties/${propertyId}/channels/${result.channelId}`);
        return;
      }
      // "No connector is implemented for AGODA" is the message that matters
      // here, and rewording it would hide which types actually work.
      setError(result.error?.message ?? null);
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        {t('add')}
      </button>
    );
  }

  return (
    <div className="w-full max-w-md space-y-3 rounded-2xl bg-white shadow-card p-4">
      <p className="text-sm font-semibold text-ink-900">{t('createTitle')}</p>

      <label className="block">
        <span className="mb-1 block text-xs text-stone-500">{t('type')}</span>
        <select
          value={type}
          onChange={(event) => setType(event.target.value as ChannelType)}
          className={inputClass}
        >
          {CHANNEL_TYPES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs text-stone-500">{t('name')}</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs text-stone-500">{t('syncHorizon')}</span>
        <input
          type="number"
          min={1}
          max={730}
          value={horizon}
          onChange={(event) => setHorizon(Number(event.target.value) || 365)}
          className={inputClass}
        />
      </label>

      {error && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {pending ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900';
