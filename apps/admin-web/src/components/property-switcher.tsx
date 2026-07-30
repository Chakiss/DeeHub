'use client';

import { usePathname, useRouter } from 'next/navigation';

/** Keeps the current section when switching hotels, rather than resetting home. */
export function PropertySwitcher({
  properties,
  currentId,
}: {
  properties: { id: string; name: string }[];
  currentId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  if (properties.length <= 1) {
    return (
      <span className="text-sm text-slate-500">
        {properties.find((property) => property.id === currentId)?.name ?? ''}
      </span>
    );
  }

  return (
    <select
      value={currentId}
      onChange={(event) => {
        const section = pathname.split('/')[4] ?? 'inventory';
        router.push(`/properties/${event.target.value}/${section}`);
      }}
      className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-700"
    >
      {properties.map((property) => (
        <option key={property.id} value={property.id}>
          {property.name}
        </option>
      ))}
    </select>
  );
}
