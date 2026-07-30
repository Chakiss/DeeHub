import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ApiError, api, type AuditEntry } from '@/lib/api';

/**
 * The audit trail, read back.
 *
 * Every write has been recorded since the first migration and nothing could
 * open it. A trail nobody can read costs storage on every write and answers
 * nothing when it matters.
 */
export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ cursor?: string; action?: string }>;
}) {
  const { propertyId } = await params;
  const { cursor, action } = await searchParams;
  const t = await getTranslations('audit');

  // Ask the server whether this person may look, rather than reproducing the
  // rule here — the same reasoning as the team page.
  let page: Awaited<ReturnType<typeof api.audit>> | null = null;
  try {
    page = await api.audit(propertyId, {
      ...(cursor ? { cursor } : {}),
      ...(action ? { action } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 403) throw error;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      {page === null ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center text-sm text-slate-600">
          {t('empty')}
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-700">
            {action ? t('emptyFiltered') : t('empty')}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-600">
                  <th className="px-3 py-2 font-medium">{t('when')}</th>
                  <th className="px-3 py-2 font-medium">{t('who')}</th>
                  <th className="px-3 py-2 font-medium">{t('what')}</th>
                  <th className="px-3 py-2 font-medium">{t('entity')}</th>
                  <th className="px-3 py-2 font-medium">{t('reason')}</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((entry) => (
                  <Row key={entry.id} entry={entry} systemLabel={t('system')} />
                ))}
              </tbody>
            </table>
          </div>

          {page.pageInfo.nextCursor && (
            <Link
              href={`?cursor=${page.pageInfo.nextCursor}${action ? `&action=${action}` : ''}`}
              className="inline-block rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              {t('loadMore')}
            </Link>
          )}
        </>
      )}
    </div>
  );
}

function Row({ entry, systemLabel }: { entry: AuditEntry; systemLabel: string }) {
  return (
    <tr className="border-b border-slate-100 align-top last:border-0">
      <td className="tabular whitespace-nowrap px-3 py-2 text-slate-600">
        {new Date(entry.createdAt).toLocaleString()}
      </td>
      <td className="px-3 py-2 text-slate-700">
        {entry.actorType === 'USER' ? (entry.actorLabel ?? '—') : systemLabel}
      </td>
      <td className="px-3 py-2">
        {/* The dotted action name verbatim. Prettifying it would need a
            translation per action and would drift the moment one is added; the
            raw name is also what appears in the code and in support requests. */}
        <span className="font-mono text-xs text-slate-800">{entry.action}</span>
      </td>
      <td className="px-3 py-2 text-xs text-slate-500">
        {entry.entityType}
        {entry.entityId && (
          <span className="block text-slate-400">{entry.entityId.slice(0, 8)}</span>
        )}
      </td>
      <td className="px-3 py-2 text-slate-600">{entry.reason ?? '—'}</td>
    </tr>
  );
}
