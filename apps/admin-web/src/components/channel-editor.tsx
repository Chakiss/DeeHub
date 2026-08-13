'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, useTransition } from 'react';
import type { ChannelDetail, MappingInput, RatePlanMappingInput } from '@/lib/api';
import {
  replaceMappings,
  syncChannel,
  testChannelConnection,
  updateChannel,
} from '@/app/properties/[propertyId]/channels/actions';

interface Draft {
  externalId: string;
  externalName: string;
  /**
   * The OTA price factor as typed — "1.8", not basis points.
   *
   * Kept as a string so a half-typed "1." does not become 1 under the user's
   * fingers. Converted once, on save.
   */
  markup: string;
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
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
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

  /**
   * Ask the channel whether the credentials work.
   *
   * A refusal from the OTA is NOT an error here: the request succeeded and the
   * answer was no. Rendering it as a failure would send somebody to look at
   * their network when the problem is an API key.
   */
  function test() {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await testChannelConnection(propertyId, channel.id);
      if (!result.ok || !result.test) {
        setError(result.error?.message ?? t('testFailed'));
        return;
      }
      setOutcome({
        ok: result.test.ok,
        text: result.test.ok
          ? t('testOk', { ms: result.test.latencyMs })
          : t('testNotOk', { detail: result.test.detail }),
      });
      router.refresh();
    });
  }

  function sync() {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await syncChannel(propertyId, channel.id);
      if (!result.ok || !result.sync) {
        setError(result.error?.message ?? t('syncFailed'));
        return;
      }
      // Per room type, because one failing does not stop the others and
      // "synced" over a partial push is the lie that matters here.
      const failed = result.sync.roomTypes.filter((row) => row.error !== null).length;
      setOutcome({
        ok: failed === 0,
        text:
          failed === 0
            ? t('syncOk', { nights: result.sync.nights, rooms: result.sync.roomTypes.length })
            : t('syncPartial', { failed, rooms: result.sync.roomTypes.length }),
      });
      router.refresh();
    });
  }

  function saveMappings() {
    run(() =>
      replaceMappings(
        propertyId,
        channel.id,
        toInputs(roomTypeDrafts),
        toRatePlanInputs(ratePlanDrafts),
      ),
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
          <span className="text-sm text-ink-700">{channel.status.toLowerCase()}</span>
          {canEdit &&
            (channel.status === 'ACTIVE' ? (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => updateChannel(propertyId, channel.id, { status: 'INACTIVE' }))
                }
                className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
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
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {t('activate')}
              </button>
            ))}
          {!fullyMapped && <span className="text-xs text-amber-700">{t('activateBlocked')}</span>}
        </div>

        {canEdit && (
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-stone-100 pt-3">
            <button
              type="button"
              disabled={pending}
              onClick={test}
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
            >
              {t('testConnection')}
            </button>
            <button
              type="button"
              disabled={pending || channel.status !== 'ACTIVE'}
              title={channel.status === 'ACTIVE' ? undefined : t('syncNeedsActive')}
              onClick={sync}
              className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70 disabled:opacity-50"
            >
              {t('syncNow')}
            </button>
            <span className="text-xs text-stone-400">{t('syncHint')}</span>
          </div>
        )}

        {outcome && (
          <p
            role="status"
            className={`mt-2 rounded-md px-3 py-2 text-sm ${
              outcome.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'
            }`}
          >
            {outcome.text}
          </p>
        )}
      </Card>

      <Card title={t('mappingsHeading')}>
        <p className="mb-3 text-xs text-stone-500">{t('mappingsHint')}</p>
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
        <p className="mb-3 text-xs text-stone-500">{t('markupHint')}</p>
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
          markupLabel={t('markup')}
        />
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={saveMappings}
            className="mt-3 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
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

          <p className="mt-3 text-xs text-stone-500">{t('credentialsHint')}</p>
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
            className="mt-2 text-xs text-stone-500 hover:text-ink-800"
          >
            + {t('addCredential')}
          </button>

          <div className="mt-3">
            <button
              type="button"
              disabled={pending}
              onClick={saveSettings}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
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
  markupLabel,
}: {
  rows: { id: string; label: string }[];
  drafts: Record<string, Draft>;
  onChange: (next: Record<string, Draft>) => void;
  disabled: boolean;
  idLabel: string;
  nameLabel: string;
  emptyLabel: string;
  /** Present only for rate plans: room types have no price to mark up. */
  markupLabel?: string;
}) {
  function set(id: string, patch: Partial<Draft>) {
    onChange({
      ...drafts,
      [id]: { externalId: '', externalName: '', markup: '1', ...drafts[id], ...patch },
    });
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const draft = drafts[row.id];
        const mapped = Boolean(draft?.externalId);
        return (
          <li
            key={row.id}
            className={`grid items-center gap-2 ${markupLabel ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}
          >
            <span className={`text-sm ${mapped ? 'text-ink-700' : 'text-amber-700'}`}>
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
            {markupLabel && (
              <input
                type="number"
                min={0.01}
                max={10}
                step={0.01}
                placeholder={markupLabel}
                aria-label={`${markupLabel} — ${row.label}`}
                disabled={disabled}
                value={draft?.markup ?? '1'}
                onChange={(event) => set(row.id, { markup: event.target.value })}
                className={inputClass}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function draftsFrom(
  locals: readonly { id: string }[],
  mappings: readonly {
    localId: string;
    externalId: string;
    externalName: string | null;
    rateMultiplierBp?: number;
  }[],
): Record<string, Draft> {
  const byLocal = new Map(mappings.map((mapping) => [mapping.localId, mapping]));
  const drafts: Record<string, Draft> = {};
  for (const local of locals) {
    const existing = byLocal.get(local.id);
    drafts[local.id] = {
      externalId: existing?.externalId ?? '',
      externalName: existing?.externalName ?? '',
      markup: formatMarkup(existing?.rateMultiplierBp ?? NEUTRAL_MARKUP_BP),
    };
  }
  return drafts;
}

/** ×1.0 — the direct price, pushed unchanged. */
const NEUTRAL_MARKUP_BP = 10_000;

function formatMarkup(basisPoints: number): string {
  return String(basisPoints / NEUTRAL_MARKUP_BP);
}

/**
 * "1.8" → 18000 basis points.
 *
 * Anything unreadable becomes the neutral factor rather than an error: the
 * worst outcome here is quietly pushing a price nobody chose, and ×1.0 is the
 * one factor that is never a surprise. The API and the database both bound the
 * value again.
 */
function toMarkupBp(value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return NEUTRAL_MARKUP_BP;
  return Math.min(100_000, Math.max(1, Math.round(parsed * NEUTRAL_MARKUP_BP)));
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

/**
 * Rate-plan mappings carry the markup; room-type mappings must not.
 *
 * The API schema is strict, so sending `rateMultiplierBp` on a room type would
 * be rejected outright rather than ignored.
 */
function toRatePlanInputs(drafts: Record<string, Draft>): RatePlanMappingInput[] {
  return toInputs(drafts).map((input) => ({
    ...input,
    rateMultiplierBp: toMarkupBp(drafts[input.localId]?.markup ?? ''),
  }));
}

const inputClass =
  'w-full rounded-md border border-stone-300 bg-white px-2.5 py-1.5 text-sm text-ink-900 disabled:bg-sunk';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white shadow-card p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-900">{title}</h2>
      {children}
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-stone-500">{label}</span>
      {children}
    </label>
  );
}
