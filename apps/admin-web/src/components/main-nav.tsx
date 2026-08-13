'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * The property menu.
 *
 * A client component only because it needs the current path: without a visible
 * selected state a menu is just a row of links, and you cannot tell where you
 * are — which was the complaint.
 */
export function MainNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex max-w-[1600px] items-center gap-1 overflow-x-auto px-6">
        {items.map((item) => {
          /*
           * Exact, or a descendant with a segment boundary.
           *
           * No two current items overlap as prefixes, so a bare startsWith
           * would work today — the boundary is here for the routes that come
           * next. A detail page like /rooms/123 should keep Rooms lit, while a
           * sibling that merely begins with the same characters should not.
           */
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-3 text-sm transition ${
                active
                  ? 'border-brand-600 font-medium text-brand-700'
                  : 'border-transparent text-stone-600 hover:border-stone-300 hover:text-ink-900'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
