import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ApiError, api, type ChannelDetail } from '@/lib/api';
import { ChannelEditor } from '@/components/channel-editor';

const JOB_TONE: Record<string, string> = {
  SUCCEEDED: 'text-emerald-700',
  RUNNING: 'text-sky-700',
  QUEUED: 'text-stone-500',
  FAILED: 'text-rose-700',
  DEAD_LETTER: 'text-rose-700',
};

const INBOUND_TONE: Record<string, string> = {
  PROCESSED: 'text-emerald-700',
  RECEIVED: 'text-stone-500',
  FAILED: 'text-rose-700',
  IGNORED: 'text-stone-400',
};

export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ propertyId: string; channelId: string }>;
}) {
  const { propertyId, channelId } = await params;
  const t = await getTranslations('channels');

  let channel: ChannelDetail;
  try {
    channel = await api.channel(propertyId, channelId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const me = await api.me();

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/properties/${propertyId}/channels`}
          className="text-sm text-stone-500 hover:text-ink-800"
        >
          ← {t('back')}
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink-900">{channel.name}</h1>
        <p className="text-xs uppercase tracking-wide text-stone-400">{channel.type}</p>
      </div>

      {channel.lastError && (
        <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {channel.lastError}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChannelEditor
            propertyId={propertyId}
            channel={channel}
            canEdit={me.capabilities.includes('channel:update')}
          />
        </div>

        <div className="space-y-5">
          <Card title={t('recentSyncs')}>
            {channel.recentJobs.length === 0 ? (
              <p className="text-sm text-stone-500">{t('noSyncs')}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {channel.recentJobs.map((job) => (
                  <li key={job.id} className="border-b border-stone-100 pb-2 last:border-0">
                    <div className="flex justify-between gap-2">
                      <span className="text-ink-700">{job.kind}</span>
                      <span
                        className={`text-xs font-medium ${JOB_TONE[job.status] ?? 'text-stone-500'}`}
                      >
                        {job.status.toLowerCase()}
                      </span>
                    </div>
                    <p className="tabular text-xs text-stone-400">
                      {job.completedAt
                        ? new Date(job.completedAt).toLocaleString('en-GB', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : '—'}
                      {job.attempts > 1 && ` · ${t('attempts')} ${String(job.attempts)}`}
                    </p>
                    {job.lastError && (
                      <p className="mt-0.5 text-xs text-rose-600">{job.lastError}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/*
            Inbound bookings the connector could not map are stored rather than
            dropped, and this is the only place they surface. A FAILED row here
            is a real guest with a confirmation who is not in the system.
          */}
          <Card title={t('recentInbound')}>
            {channel.recentInbound.length === 0 ? (
              <p className="text-sm text-stone-500">{t('noInbound')}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {channel.recentInbound.map((inbound) => (
                  <li key={inbound.id} className="border-b border-stone-100 pb-2 last:border-0">
                    <div className="flex justify-between gap-2">
                      {inbound.reservationId ? (
                        <Link
                          href={`/properties/${propertyId}/reservations/${inbound.reservationId}`}
                          className="tabular text-ink-800 underline-offset-2 hover:underline"
                        >
                          {inbound.externalReservationId}
                        </Link>
                      ) : (
                        <span className="tabular text-ink-700">
                          {inbound.externalReservationId}
                        </span>
                      )}
                      <span
                        className={`text-xs font-medium ${
                          INBOUND_TONE[inbound.status] ?? 'text-stone-500'
                        }`}
                      >
                        {inbound.status.toLowerCase()}
                      </span>
                    </div>
                    <p className="tabular text-xs text-stone-400">
                      {new Date(inbound.receivedAt).toLocaleString('en-GB', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })}
                    </p>
                    {inbound.error && (
                      <p className="mt-0.5 text-xs text-rose-600">{inbound.error}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white shadow-card p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink-900">{title}</h2>
      {children}
    </section>
  );
}
