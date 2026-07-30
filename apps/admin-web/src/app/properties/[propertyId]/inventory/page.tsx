import { getTranslations } from 'next-intl/server';
import { api } from '@/lib/api';
import { InventoryGrid } from '@/components/inventory-grid';
import { addDays, businessDate } from '@/lib/dates';

const DEFAULT_WINDOW_DAYS = 21;

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { propertyId } = await params;
  const { from: fromParam } = await searchParams;
  const t = await getTranslations('inventory');

  // Default to today in the property's timezone, not the server's — a Bangkok
  // hotel viewed from a us-central1 instance must not open on yesterday.
  const properties = await api.properties();
  const property = properties.find((candidate) => candidate.id === propertyId);
  const from = fromParam ?? businessDate(property?.timezone ?? 'Asia/Bangkok');
  const to = addDays(from, DEFAULT_WINDOW_DAYS);

  const grid = await api.inventoryGrid(propertyId, from, to);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{t('title')}</h1>
        <p className="text-sm text-slate-500">{t('subtitle')}</p>
      </div>

      <InventoryGrid
        propertyId={propertyId}
        grid={grid}
        from={from}
        windowDays={DEFAULT_WINDOW_DAYS}
      />
    </div>
  );
}
