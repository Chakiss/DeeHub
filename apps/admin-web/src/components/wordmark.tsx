import Image from 'next/image';

/**
 * The DeeHub lockup: mark plus the two-tone wordmark.
 *
 * One component rather than the same markup retyped in every header — the
 * brand was written out as plain text in four places, which is how a rename or
 * a colour change ends up half-applied.
 *
 * `tone` follows the brand sheet's two lockups: `dark` is the wordmark on a
 * light surface, `light` is the reversed one used on the navy card. Both keep
 * "Hub" in the azure, because that split is the wordmark.
 */
export function Wordmark({
  tone = 'dark',
  showTagline = false,
  size = 'sm',
}: {
  tone?: 'dark' | 'light';
  showTagline?: boolean;
  size?: 'sm' | 'lg';
}) {
  const mark = size === 'lg' ? 44 : 26;

  return (
    <span className="flex items-center gap-2.5">
      <Image
        src="/logo.png"
        alt=""
        width={mark}
        height={mark}
        // Decorative: the wordmark beside it already says the name, so a second
        // announcement would just repeat it to a screen reader.
        aria-hidden
        priority={size === 'lg'}
        // Served as-is rather than through the image optimizer. It is a 26px
        // mark, so there is nothing to gain, and the optimizer needs sharp in
        // the standalone container — a runtime dependency for no benefit.
        unoptimized
        className="shrink-0"
      />
      <span className="flex flex-col leading-none">
        <span
          className={`font-semibold tracking-tight ${size === 'lg' ? 'text-2xl' : 'text-base'}`}
        >
          <span className={tone === 'light' ? 'text-white' : 'text-ink-900'}>Dee</span>
          <span className={tone === 'light' ? 'text-brand-400' : 'text-brand-600'}>Hub</span>
        </span>
        {showTagline && (
          <span
            className={`mt-1.5 text-xs ${tone === 'light' ? 'text-slate-300' : 'text-slate-500'}`}
          >
            One Hub. Every Booking.
          </span>
        )}
      </span>
    </span>
  );
}
