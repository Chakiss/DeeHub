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

  const current = properties.find((property) => property.id === currentId)?.name ?? '';

  // One hotel: it is context, not a choice, so it reads as a label rather than
  // pretending to be a control that does nothing when clicked.
  if (properties.length <= 1) {
    return <span className="truncate text-sm font-medium text-white">{current}</span>;
  }

  return (
    <select
      value={currentId}
      onChange={(event) => {
        const section = pathname.split('/')[4] ?? 'inventory';
        router.push(`/properties/${event.target.value}/${section}`);
      }}
      className="rounded-md border border-white/20 bg-white/10 px-2 py-1.5 text-sm text-white [&>option]:text-slate-900"
    >
      {properties.map((property) => (
        <option key={property.id} value={property.id}>
          {property.name}
        </option>
      ))}
    </select>
  );
}
