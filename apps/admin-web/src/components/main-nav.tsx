'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  readonly href: string;
  readonly label: string;
}

/**
 * The property menu — a left rail on desktop, a scrolling pill row on small
 * screens (docs/design-restyle-plan.md §5, Phase B).
 *
 * Two <nav> elements, one per breakpoint, and only ever one of them visible:
 * `hidden`/`lg:hidden` is display:none, which removes the hidden one from the
 * accessibility tree, so assistive tech and role-based test selectors see a
 * single "Main" navigation either way.
 *
 * A client component only because it needs the current path: without a visible
 * selected state a menu is just a row of links, and you cannot tell where you
 * are — which was the complaint.
 */
export function MainNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  /*
   * Exact, or a descendant with a segment boundary.
   *
   * No two current items overlap as prefixes, so a bare startsWith would work
   * today — the boundary is here for the routes that come next. A detail page
   * like /rooms/123 should keep Rooms lit, while a sibling that merely begins
   * with the same characters should not.
   */
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      {/* The rail. Sticky so the menu is still there at the bottom of a long
          rate grid; top offset clears the navy bar. */}
      <nav
        aria-label="Main"
        className="sticky top-4 hidden w-52 shrink-0 self-start rounded-2xl bg-white p-2.5 shadow-card lg:block"
      >
        <ul className="space-y-0.5">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`block rounded-lg px-3 py-2 text-sm transition ${
                    active
                      ? 'bg-brand-50 font-medium text-brand-700'
                      : 'text-stone-600 hover:bg-sunk/70 hover:text-ink-900'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Small screens: the same items as a scrolling pill row. */}
      <nav aria-label="Main" className="-mx-6 mb-4 overflow-x-auto px-6 lg:hidden">
        <div className="flex gap-1.5">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`shrink-0 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition ${
                  active
                    ? 'bg-brand-600 font-medium text-white'
                    : 'bg-white text-stone-600 shadow-card hover:text-ink-900'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
