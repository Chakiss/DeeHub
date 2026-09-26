import { useTranslations } from 'next-intl';
import { badgeFor } from '@/lib/channel-badge';

/** Stroke icons for the sources that have no brand to letter. */
const ICONS: Record<string, React.ReactNode> = {
  WALK_IN: (
    <>
      <circle cx="12" cy="6" r="3" />
      <path d="M9 21v-6l-2-4 5-2 3 4 3 1M12 15l3 6" />
    </>
  ),
  PHONE: (
    <path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11 11 0 0 0 3.5.55 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11 11 0 0 0 .55 3.5 1 1 0 0 1-.25 1z" />
  ),
  EMAIL: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </>
  ),
  TRAVEL_AGENT: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18" />
    </>
  ),
};

/**
 * Where a booking came from, as a 14px mark: "B." for Booking.com, a red
 * "a" for Agoda, a walking figure for a walk-in. Read out in full for
 * screen readers and shown in full on hover.
 */
export function ChannelBadge({
  source,
  bookingSourceName,
  channelType,
  size = 'sm',
}: {
  source: string;
  bookingSourceName?: string | null;
  channelType?: string | null;
  size?: 'sm' | 'md';
}) {
  const t = useTranslations('reservations');
  const badge = badgeFor({ source, bookingSourceName, channelType });
  const label =
    bookingSourceName ??
    (t.has(`badge${badge.key}`)
      ? t(`badge${badge.key}`)
      : t.has(`source${source}`)
        ? t(`source${source}`)
        : source);
  const box = size === 'md' ? 'h-5 w-5 text-[11px]' : 'h-3.5 w-3.5 text-[9px]';
  const icon = badge.mark === null ? ICONS[badge.key] : null;

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-[3px] font-bold leading-none ${box} ${badge.className}`}
    >
      {icon ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[80%] w-[80%]"
          aria-hidden
        >
          {icon}
        </svg>
      ) : (
        badge.mark
      )}
    </span>
  );
}
