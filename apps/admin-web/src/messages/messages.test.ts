import { describe, expect, it } from 'vitest';
import en from './en.json';
import th from './th.json';

/**
 * The two catalogues must stay the same shape.
 *
 * next-intl renders a missing key as the raw key path — "reports.revparHint"
 * on the screen — and nothing fails, so a translation that falls behind is
 * invisible until a hotel reports it. This is the cheapest place to catch it.
 */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key),
  );
}

/** Placeholders like {count} — a translation that drops one renders nothing. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') {
    out.set(prefix, value);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      for (const [path, text] of flatten(child, prefix ? `${prefix}.${key}` : key)) {
        out.set(path, text);
      }
    }
  }
  return out;
}

describe('message catalogues', () => {
  it('has the same keys in every locale', () => {
    const english = paths(en).sort();
    const thai = paths(th).sort();

    expect(
      thai.filter((key) => !english.includes(key)),
      'extra keys in th',
    ).toEqual([]);
    expect(
      english.filter((key) => !thai.includes(key)),
      'missing from th',
    ).toEqual([]);
  });

  it('keeps every placeholder in the translation', () => {
    const english = flatten(en);
    const thai = flatten(th);

    for (const [key, source] of english) {
      const translated = thai.get(key);
      if (translated === undefined) continue;
      // A dropped {count} renders as nothing at all, which reads as a bug
      // rather than as a missing translation.
      expect(placeholders(translated), `placeholders in ${key}`).toEqual(placeholders(source));
    }
  });

  it('actually translates rather than copying English through', () => {
    const english = flatten(en);
    const thai = flatten(th);

    // Brand names and abbreviations are the same in both on purpose.
    const sameByDesign = new Set(['app.name', 'app.tagline', 'login.subtitle', 'guests.never']);
    const untranslated = [...english]
      .filter(([key, text]) => !sameByDesign.has(key) && thai.get(key) === text)
      // Short tokens like "ADR" and "RevPAR" stay as they are in Thai too.
      .filter(([, text]) => text.length > 8)
      .map(([key]) => key);

    expect(untranslated, 'left in English').toEqual([]);
  });
});
