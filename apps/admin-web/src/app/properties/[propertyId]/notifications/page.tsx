import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ApiError, api, type NotificationEntry } from '@/lib/api';

const STATUS_TONE: Record<string, string> = {
  SENT: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-200',
  FAILED: 'bg-rose-50 text-rose-700 ring-rose-200',
  SKIPPED: 'bg-sunk text-stone-600 ring-stone-200',
};

/** The statuses worth a filter chip, in the order they matter. */
const FILTERS = ['FAILED', 'SKIPPED', 'PENDING', 'SENT'] as const;

/**
 * What the hotel told people, and what it failed to tell them.
 *
 * The failures are why this screen exists. Delivery depends on a provider and
 * on configuration nobody here touches daily; a confirmation that never
 * arrived looks exactly like one that did unless there is somewhere to look.
 * So the counts lead, the stored body is readable in full, and a message that
 * went nowhere says why on its own row.
 */
export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ cursor?: string; status?: string }>;
}) {
  const { propertyId } = await params;
  const { cursor, status } = await searchParams;
  const t = await getTranslations('notifications');

  // Ask the server whether this person may look, rather than reproducing the
  // rule here — the same reasoning as the audit and team pages.
  let page: Awaited<ReturnType<typeof api.notifications>> | null = null;
  try {
    page = await api.notifications(propertyId, {
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
        <p className="text-sm text-stone-500">{t('subtitle')}</p>
      </div>

      {page === null ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center text-sm text-stone-600">
          {t('empty')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip href="?" active={!status} label={t('all')} count={total(page.summary)} />
            {FILTERS.map((value) => (
              <Chip
                key={value}
                href={`?status=${value}`}
                active={status === value}
                label={t(`status${value}`)}
                count={page.summary[value] ?? 0}
              />
            ))}
          </div>

          {page.items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-stone-300 bg-white px-6 py-10 text-center">
              <p className="text-sm font-medium text-ink-700">
                {status ? t('emptyFiltered') : t('empty')}
              </p>
              <p className="mt-1 text-sm text-stone-500">{t('emptyHint')}</p>
            </div>
          ) : (
            <>
              <ul className="space-y-2">
                {page.items.map((entry) => (
                  <Row
                    key={entry.id}
                    entry={entry}
                    propertyId={propertyId}
                    kindLabel={t(`kind${entry.kind}`)}
                    statusLabel={t(`status${entry.status}`)}
                    bookingLabel={t('booking')}
                    attemptsLabel={t('attempts')}
                    showLabel={t('show')}
                  />
                ))}
              </ul>

              {page.pageInfo.nextCursor && (
                <Link
                  href={`?cursor=${page.pageInfo.nextCursor}${status ? `&status=${status}` : ''}`}
                  className="inline-block rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-ink-700 hover:bg-sunk/70"
                >
                  {t('loadMore')}
                </Link>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function total(summary: Record<string, number>): number {
  return Object.values(summary).reduce((sum, count) => sum + count, 0);
}

function Chip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${
        active
          ? 'bg-brand-600 text-white ring-brand-600'
          : 'bg-white text-ink-700 ring-stone-300 hover:bg-sunk/70'
      }`}
    >
      {label} <span className="tabular opacity-70">{count}</span>
    </Link>
  );
}

function Row({
  entry,
  propertyId,
  kindLabel,
  statusLabel,
  bookingLabel,
  attemptsLabel,
  showLabel,
}: {
  entry: NotificationEntry;
  propertyId: string;
  kindLabel: string;
  statusLabel: string;
  bookingLabel: string;
  attemptsLabel: string;
  showLabel: string;
}) {
  const when = entry.sentAt ?? entry.createdAt;

  return (
    <li className="rounded-2xl border border-stone-200/70 bg-white shadow-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
            STATUS_TONE[entry.status] ?? 'bg-sunk text-stone-600 ring-stone-200'
          }`}
        >
          {statusLabel}
        </span>
        <span className="text-sm font-medium text-ink-900">{kindLabel}</span>
        <span className="text-xs text-stone-500">{entry.channel}</span>
        <span className="text-sm text-ink-700">{entry.recipient || '—'}</span>
        <span className="tabular ml-auto text-xs text-stone-500">
          {new Date(when).toLocaleString()}
        </span>
      </div>

      {/* The reason a message went nowhere is the whole point of the row. */}
      {entry.skippedReason && (
        <p className="mt-2 rounded-md bg-sunk px-2 py-1 text-xs text-stone-600">
          {entry.skippedReason}
        </p>
      )}
      {entry.lastError && (
        <p className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-700">
          {entry.lastError}
          {entry.attempts > 1 && (
            <span className="ml-1 text-rose-500">
              ({attemptsLabel} {entry.attempts})
            </span>
          )}
        </p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-stone-500">{showLabel}</summary>
        {entry.subject && <p className="mt-1 text-sm font-medium text-ink-800">{entry.subject}</p>}
        {/* Exactly the stored text. A message is evidence of what was said. */}
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-sans text-sm text-ink-700">
          {entry.body}
        </pre>
      </details>

      {entry.reservationId && (
        <Link
          href={`/properties/${propertyId}/reservations/${entry.reservationId}`}
          className="mt-2 inline-block text-xs text-stone-500 underline-offset-2 hover:text-ink-800 hover:underline"
        >
          {bookingLabel} {entry.context?.code ?? ''}
        </Link>
      )}
    </li>
  );
}
