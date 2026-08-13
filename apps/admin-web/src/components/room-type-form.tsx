'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { RoomType } from '@/lib/api';
import { createRoomType, updateRoomType } from '@/app/properties/[propertyId]/room-types/actions';

interface Props {
  propertyId: string;
  /** Absent when creating. Present when editing — the code is then fixed. */
  roomType?: RoomType;
  onClose: () => void;
}

export function RoomTypeForm({ propertyId, roomType, onClose }: Props) {
  const t = useTranslations('roomTypes');
  const editing = roomType !== undefined;

  const [code, setCode] = useState(roomType?.code ?? '');
  const [name, setName] = useState(roomType?.name ?? '');
  const [description, setDescription] = useState(roomType?.description ?? '');
  const [standardOccupancy, setStandard] = useState(roomType?.standardOccupancy ?? 2);
  const [maxOccupancy, setMaxOccupancy] = useState(roomType?.maxOccupancy ?? 2);
  const [maxAdults, setMaxAdults] = useState(roomType?.maxAdults ?? 2);
  const [maxChildren, setMaxChildren] = useState(roomType?.maxChildren ?? 0);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaving(true);

    const shape = {
      name,
      description: description.trim() || null,
      standardOccupancy,
      maxOccupancy,
      maxAdults,
      maxChildren,
    };

    const result = editing
      ? await updateRoomType(propertyId, roomType.id, shape)
      : await createRoomType(propertyId, { code, ...shape });

    setSaving(false);

    if (!result.ok) {
      // CONFLICT has exactly one cause here, so say the useful thing instead of
      // echoing a server message that mentions a constraint.
      setError(
        result.error?.code === 'CONFLICT' ? t('codeTaken') : (result.error?.message ?? t('failed')),
      );
      return;
    }

    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editing ? t('edit') : t('add')}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/40 p-4 sm:items-center"
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white shadow-card p-6 shadow-lg"
      >
        <h2 className="text-lg font-medium text-ink-900">{editing ? t('edit') : t('add')}</h2>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="rt-code" label={t('code')} hint={editing ? undefined : t('codeHint')}>
            <input
              id="rt-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              // Immutable once set: OTA mappings and imports refer to it, so
              // changing it would silently repoint them at a different room.
              disabled={editing}
              required
              maxLength={32}
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm uppercase outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 disabled:bg-sunk disabled:text-stone-500"
              placeholder="DLX"
            />
          </Field>

          <Field id="rt-name" label={t('name')}>
            <input
              id="rt-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
              placeholder="Deluxe Double"
            />
          </Field>
        </div>

        <Field id="rt-description" label={t('description')}>
          <textarea
            id="rt-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            maxLength={2000}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </Field>

        <fieldset className="grid gap-4 sm:grid-cols-4">
          <legend className="mb-1 text-sm font-medium text-ink-700">{t('occupancy')}</legend>
          <Number
            id="rt-standard"
            label={t('standardOccupancy')}
            hint={t('standardHint')}
            value={standardOccupancy}
            min={1}
            onChange={setStandard}
          />
          <Number
            id="rt-max"
            label={t('maxOccupancy')}
            value={maxOccupancy}
            min={1}
            onChange={setMaxOccupancy}
          />
          <Number
            id="rt-adults"
            label={t('maxAdults')}
            value={maxAdults}
            min={1}
            onChange={setMaxAdults}
          />
          <Number
            id="rt-children"
            label={t('maxChildren')}
            value={maxChildren}
            min={0}
            onChange={setMaxChildren}
          />
        </fieldset>

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

function Number({
  id,
  label,
  hint,
  value,
  min,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={30}
        required
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </Field>
  );
}

/** Hint via aria-describedby, so it does not become part of the field's name. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-ink-700">
        {label}
      </label>
      {children}
      {hint && (
        <span id={`${id}-hint`} className="mt-1 block text-xs text-stone-400">
          {hint}
        </span>
      )}
    </div>
  );
}
