'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ChannelDetail, MappingInput } from '@/lib/api';
import { replaceMappings, updateChannel } from '@/app/properties/[propertyId]/channels/actions';

interface Draft {
  externalId: string;
  externalName: string;
}

/**
 * Mapping, credentials and the activation switch.
 *
 * Mapping is presented as one row per LOCAL room type rather than a list of
 * existing mappings, because the interesting rows are the empty ones: an
 * unmapped room type is silently never pushed, and a list of what IS mapped
 * hides exactly that.
 */
export function ChannelEditor({
  propertyId,
  channel,
  canEdit,
}: {
  propertyId: string;
  channel: ChannelDetail;
  canEdit: boolean;
}) {
  const t = useTranslations('channels');
  const router = useRouter();

  const [roomTypeDrafts, setRoomTypeDrafts] = useState<Record<string, Draft>>(() =>
    draftsFrom(channel.availableRoomTypes, channel.roomTypeMappings),
  );
  const [ratePlanDrafts, setRatePlanDrafts] = useState<Record<string, Draft>>(() =>
    draftsFrom(channel.availableRatePlans, channel.ratePlanMappings),
  );
  const [credentials, setCredentials] = useState<{ key: string; value: string }[]>([
    { key: '', value: '' },
  ]);
  const [name, setName] = useState(channel.name);
  const [horizon, setHorizon] = useState(channel.syncHorizonDays);

  const [error, setError] = useState<string | null>(null);
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  function run(action: () => ReturnType<typeof updateChannel>) {
    setError(null);
    setUnmapped([]);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
        return;
      }
      // The API names which room types are missing; showing them is the
      // difference between "it refused" and "here is what to fix".
      const details = result.error?.details as { unmapped?: string[] } | undefined;
      if (details?.unmapped) setUnmapped(details.unmapped);
      setError(result.error?.message ?? null);
    });
  }

  function saveMappings() {
    run(() =>
      replaceMappings(propertyId, channel.id, toInputs(roomTypeDrafts), toInputs(ratePlanDrafts)),
    );
  }

  function saveSettings() {
    // Blank credential rows are dropped, so leaving the form untouched keeps
    // whatever is already encrypted rather than overwriting it with nothing.
    const entries = credentials.filter((row) => row.key.trim() && row.value.trim());
    run(() =>
      updateChannel(propertyId, channel.id, {
        name: name.trim(),
        syncHorizonDays: horizon,
        ...(entries.length > 0
          ? {
              credentials: Object.fromEntries(
                entries.map((row) => [row.key.trim(), row.value.trim()]),
              ),
            }
          : {}),
      }),
    );
  }

  const fullyMapped =
    channel.totalRoomTypes > 0 && channel.mappedRoomTypes >= channel.totalRoomTypes;

  return (
    <div className="space-y-5">
      {(error ?? unmapped.length > 0) && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <p>{error}</p>
          {unmapped.length > 0 && (
            <ul className="mt-1 list-inside list-disc">
              {unmapped.map((roomType) => (
                <li key={roomType}>{roomType}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Card title={t('status')}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-700">{channel.status.toLowerCase()}</span>
          {canEdit &&
            (channel.status === 'ACTIVE' ? (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => updateChannel(propertyId, channel.id, { status: 'INACTIVE' }))
                }
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {t('deactivate')}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending || !fullyMapped}
                title={fullyMapped ? undefined : t('activateBlocked')}
                onClick={() =>
                  run(() => updateChannel(propertyId, channel.id, { status: 'ACTIVE' }))
                }
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {t('activate')}
              </button>
            ))}
          {!fullyMapped && <span className="text-xs text-amber-700">{t('activateBlocked')}</span>}
        </div>
      </Card>

      <Card title={t('mappingsHeading')}>
        <p className="mb-3 text-xs text-slate-500">{t('mappingsHint')}</p>
        <MappingTable
          rows={channel.availableRoomTypes.map((roomType) => ({
            id: roomType.id,
            label: `${roomType.name} (${roomType.code})`,
          }))}
          drafts={roomTypeDrafts}
          onChange={setRoomTypeDrafts}
          disabled={!canEdit}
          idLabel={t('externalId')}
          nameLabel={t('externalName')}
          emptyLabel={t('notMapped')}
        />
      </Card>

      <Card title={t('ratePlanMappingsHeading')}>
        <MappingTable
          rows={channel.availableRatePlans.map((plan) => ({
            id: plan.id,
            label: `${plan.name} (${plan.code})`,
          }))}
          drafts={ratePlanDrafts}
          onChange={setRatePlanDrafts}
          disabled={!canEdit}
          idLabel={t('externalId')}
          nameLabel={t('externalName')}
          emptyLabel={t('notMapped')}
        />
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={saveMappings}
            className="mt-3 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {pending ? t('saving') : t('saveMappings')}
          </button>
        )}
      </Card>

      {canEdit && (
        <Card title={t('credentials')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labelled label={t('name')}>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
              />
            </Labelled>
            <Labelled label={t('syncHorizon')}>
              <input
                type="number"
                min={1}
                max={730}
                value={horizon}
                onChange={(event) => setHorizon(Number(event.target.value) || 365)}
                className={inputClass}
              />
            </Labelled>
          </div>

          <p className="mt-3 text-xs text-slate-500">{t('credentialsHint')}</p>
          <ul className="mt-2 space-y-2">
            {credentials.map((row, index) => (
              <li key={index} className="flex gap-2">
                <input
                  type="text"
                  placeholder={t('credentialKey')}
                  value={row.key}
                  onChange={(event) =>
                    setCredentials((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                  className={`${inputClass} w-1/3`}
                />
                {/*
                  type=password so a shoulder-surfer at the front desk cannot
                  read an OTA password off the screen. It is write-only anyway:
                  nothing stored is ever loaded back into this field.
                */}
                <input
                  type="password"
                  placeholder={t('credentialValue')}
                  value={row.value}
                  onChange={(event) =>
                    setCredentials((current) =>
                      current.map((item, position) =>
                        position === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                  className={inputClass}
                />
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setCredentials((current) => [...current, { key: '', value: '' }])}
            className="mt-2 text-xs text-slate-500 hover:text-slate-800"
          >
            + {t('addCredential')}
          </button>

          <div className="mt-3">
            <button
              type="button"
              disabled={pending}
              onClick={saveSettings}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {pending ? t('saving') : t('save')}
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}

function MappingTable({
  rows,
  drafts,
  onChange,
  disabled,
  idLabel,
  nameLabel,
  emptyLabel,
}: {
  rows: { id: string; label: string }[];
  drafts: Record<string, Draft>;
  onChange: (next: Record<string, Draft>) => void;
  disabled: boolean;
  idLabel: string;
  nameLabel: string;
  emptyLabel: string;
}) {
  function set(id: string, patch: Partial<Draft>) {
    onChange({
      ...drafts,
      [id]: { externalId: '', externalName: '', ...drafts[id], ...patch },
    });
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const draft = drafts[row.id];
        const mapped = Boolean(draft?.externalId);
        return (
          <li key={row.id} className="grid items-center gap-2 sm:grid-cols-3">
            <span className={`text-sm ${mapped ? 'text-slate-700' : 'text-amber-700'}`}>
              {row.label}
              {!mapped && <span className="ml-2 text-xs">({emptyLabel})</span>}
            </span>
            <input
              type="text"
              placeholder={idLabel}
              disabled={disabled}
              value={draft?.externalId ?? ''}
              onChange={(event) => set(row.id, { externalId: event.target.value })}
              className={inputClass}
            />
            <input
              type="text"
              placeholder={nameLabel}
              disabled={disabled}
              value={draft?.externalName ?? ''}
              onChange={(event) => set(row.id, { externalName: event.target.value })}
              className={inputClass}
            />
          </li>
        );
      })}
    </ul>
  );
}

function draftsFrom(
  locals: readonly { id: string }[],
  mappings: readonly { localId: string; externalId: string; externalName: string | null }[],
): Record<string, Draft> {
  const byLocal = new Map(mappings.map((mapping) => [mapping.localId, mapping]));
  const drafts: Record<string, Draft> = {};
  for (const local of locals) {
    const existing = byLocal.get(local.id);
    drafts[local.id] = {
      externalId: existing?.externalId ?? '',
      externalName: existing?.externalName ?? '',
    };
  }
  return drafts;
}

/** A blank external id means "not mapped", and is dropped rather than sent. */
function toInputs(drafts: Record<string, Draft>): MappingInput[] {
  return Object.entries(drafts)
    .filter(([, draft]) => draft.externalId.trim())
    .map(([localId, draft]) => ({
      localId,
      externalId: draft.externalId.trim(),
      ...(draft.externalName.trim() ? { externalName: draft.externalName.trim() } : {}),
    }));
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 disabled:bg-slate-50';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-slate-500">{label}</span>
      {children}
    </label>
  );
}
