/**
 * Tiny XML helpers. Google's Hotel Prices messages are small, regular and
 * schema-checked on their side, so hand-built strings are clearer than a
 * builder library — and every value passes through `esc`, so a rate plan
 * named "B&B" cannot break a document.
 */
export function esc(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function attrs(values: Record<string, string | number | null | undefined>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => ` ${key}="${esc(value as string | number)}"`)
    .join('');
}

/** ISO 8601 with offset, the shape Google's examples use. */
export function timestamp(now: Date): string {
  return now.toISOString();
}

/** Minor units → "1234.50". Google wants decimals; the domain keeps integers. */
export function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

/**
 * Collapse consecutive dates that carry the same value into ranges, so a
 * year of identical prices is one element rather than 365. `dates` must be
 * sorted. Days absent from `valueOf` end a run.
 */
export function runs<T>(
  dates: readonly string[],
  valueOf: (date: string) => T | undefined,
  same: (a: T, b: T) => boolean,
): { start: string; end: string; value: T }[] {
  const out: { start: string; end: string; value: T }[] = [];
  let current: { start: string; end: string; value: T } | null = null;
  for (const date of dates) {
    const value = valueOf(date);
    if (value === undefined) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    if (current && same(current.value, value) && nextDay(current.end) === date) {
      current = { start: current.start, end: date, value: current.value };
    } else {
      if (current) out.push(current);
      current = { start: date, end: date, value };
    }
  }
  if (current) out.push(current);
  return out;
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
