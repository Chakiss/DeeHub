import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { ChannelCreateForm } from '@/components/channel-create-form';

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  INACTIVE: 'bg-sunk text-stone-600 ring-stone-200',
  ERROR: 'bg-rose-50 text-rose-700 ring-rose-200',
};

export default async function ChannelsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const t = await getTranslations('channels');

  const [channels, me] = await Promise.all([api.channels(propertyId), api.me()]);
  const canCreate = me.capabilities.includes('channel:create');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t('title')}</h1>
          <p className="text-sm text-stone-500">{t('subtitle')}</p>
        </div>
        {canCreate && <ChannelCreateForm propertyId={propertyId} />}
      </div>

      {channels.length === 0 ? (
        <div className="rounded-2xl bg-white shadow-card p-10 text-center">
          <p className="font-medium text-ink-900">{t('empty')}</p>
          <p className="mt-1 text-sm text-stone-500">{t('emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-white shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 bg-sunk text-left text-stone-600">
                <Th>{t('name')}</Th>
                <Th>{t('type')}</Th>
                <Th>{t('status')}</Th>
                <Th>{t('mapping')}</Th>
                <Th>{t('credentials')}</Th>
                <Th>{t('lastSync')}</Th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => {
                const fullyMapped =
                  channel.totalRoomTypes > 0 && channel.mappedRoomTypes >= channel.totalRoomTypes;
                return (
                  <tr key={channel.id} className="border-b border-stone-100 hover:bg-sunk/70">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/properties/${propertyId}/channels/${channel.id}`}
                        className="font-medium text-ink-900 underline-offset-2 hover:underline"
                      >
                        {channel.name}
                      </Link>
                      {channel.lastError && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-rose-600">
                          {channel.lastError}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs uppercase tracking-wide text-stone-400">
                      {channel.type}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                          STATUS_TONE[channel.status] ?? 'bg-sunk text-stone-600 ring-stone-200'
                        }`}
                      >
                        {channel.status.toLowerCase()}
                      </span>
                    </td>
                    {/*
                      Mapping coverage is the number that predicts an oversell:
                      an unmapped room type is simply never pushed.
                    */}
                    <td
                      className={`px-4 py-2.5 ${fullyMapped ? 'text-stone-600' : 'text-amber-700'}`}
                    >
                      {t('mappedOf', {
                        mapped: channel.mappedRoomTypes,
                        total: channel.totalRoomTypes,
                      })}
                    </td>
                    <td className="px-4 py-2.5 text-stone-600">
                      {channel.hasCredentials ? t('credentialsStored') : t('credentialsMissing')}
                    </td>
                    <td className="tabular px-4 py-2.5 text-stone-600">
                      {channel.lastSyncAt
                        ? new Date(channel.lastSyncAt).toLocaleString('en-GB', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })
                        : t('never')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2.5 font-medium">{children}</th>;
}
