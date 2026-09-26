/**
 * Which badge a booking gets, from where it came from.
 *
 * Lettermarks in each brand's colour rather than the OTAs' logos: the marks
 * are ours to draw, they stay legible at 14px, and it is what the desk
 * already reads on other products ("B." is Booking.com everywhere).
 *
 * Precedence: the connected channel is authoritative when there is one; a
 * booking source the property named ("Booking.com", "Agoda extranet") is
 * matched by name; and the plain source (walk-in, phone…) is the fallback.
 */
export type BadgeKey =
  | 'BOOKING_COM'
  | 'AGODA'
  | 'EXPEDIA'
  | 'TRIP_COM'
  | 'AIRBNB'
  | 'GOOGLE_HOTEL'
  | 'OTA'
  | 'DIRECT'
  | 'WALK_IN'
  | 'PHONE'
  | 'EMAIL'
  | 'TRAVEL_AGENT'
  | 'UNKNOWN';

export interface BadgeSpec {
  readonly key: BadgeKey;
  /** One or two characters, or null when an icon is drawn instead. */
  readonly mark: string | null;
  /** Tailwind classes for the 14px square. */
  readonly className: string;
}

const SPECS: Record<BadgeKey, Omit<BadgeSpec, 'key'>> = {
  BOOKING_COM: { mark: 'B.', className: 'bg-[#003580] text-white' },
  AGODA: { mark: 'a', className: 'bg-[#d8232a] text-white' },
  EXPEDIA: { mark: 'e', className: 'bg-[#ffc94d] text-[#191e3b]' },
  TRIP_COM: { mark: 'T', className: 'bg-[#2577e3] text-white' },
  AIRBNB: { mark: 'A', className: 'bg-[#ff5a5f] text-white' },
  GOOGLE_HOTEL: { mark: 'G', className: 'bg-white text-[#4285f4] ring-1 ring-stone-300' },
  OTA: { mark: 'O', className: 'bg-ink-700 text-white' },
  DIRECT: { mark: 'D', className: 'bg-brand-600 text-white' },
  WALK_IN: { mark: null, className: 'bg-stone-200 text-ink-800' },
  PHONE: { mark: null, className: 'bg-stone-200 text-ink-800' },
  EMAIL: { mark: null, className: 'bg-stone-200 text-ink-800' },
  TRAVEL_AGENT: { mark: null, className: 'bg-stone-200 text-ink-800' },
  UNKNOWN: { mark: '?', className: 'bg-stone-200 text-stone-500' },
};

const NAME_PATTERNS: [RegExp, BadgeKey][] = [
  [/booking/i, 'BOOKING_COM'],
  [/agoda/i, 'AGODA'],
  [/expedia|hotels\.com/i, 'EXPEDIA'],
  [/trip\.?com|ctrip/i, 'TRIP_COM'],
  [/airbnb/i, 'AIRBNB'],
  [/google/i, 'GOOGLE_HOTEL'],
];

export function badgeKeyFor(booking: {
  source: string;
  bookingSourceName?: string | null;
  channelType?: string | null;
}): BadgeKey {
  const channel = booking.channelType;
  if (channel && channel in SPECS && channel !== 'OTA') return channel as BadgeKey;
  if (channel === 'MOCK_OTA') return 'OTA';

  const name = booking.bookingSourceName;
  if (name) {
    for (const [pattern, key] of NAME_PATTERNS) if (pattern.test(name)) return key;
    return booking.source === 'TRAVEL_AGENT' ? 'TRAVEL_AGENT' : 'OTA';
  }

  switch (booking.source) {
    case 'DIRECT':
    case 'WALK_IN':
    case 'PHONE':
    case 'EMAIL':
    case 'TRAVEL_AGENT':
    case 'OTA':
      return booking.source;
    default:
      return 'UNKNOWN';
  }
}

export function badgeFor(booking: Parameters<typeof badgeKeyFor>[0]): BadgeSpec {
  const key = badgeKeyFor(booking);
  return { key, ...SPECS[key] };
}
