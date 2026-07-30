import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword } from './temporary-password';

describe('generateTemporaryPassword', () => {
  it('produces four groups of five', () => {
    expect(generateTemporaryPassword()).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
  });

  // Read off a screen and typed by someone who did not choose it, often over
  // the phone. i/l/1 and o/0 are where that goes wrong.
  it('never uses characters that are misread', () => {
    const sample = Array.from({ length: 200 }, () => generateTemporaryPassword()).join('');
    expect(sample).not.toMatch(/[ilo01]/);
  });

  it('does not repeat itself', () => {
    const generated = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(generated.size).toBe(500);
  });

  /**
   * 256 is not a multiple of 31, so a plain `byte % 31` would make the first
   * nine letters roughly 13% likelier than the rest. This checks the rejection
   * sampling actually removed that, with a band wide enough not to be flaky.
   */
  it('draws each character with roughly equal probability', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i += 1) {
      for (const char of generateTemporaryPassword().replaceAll('-', '')) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    const expected = (4000 * 20) / 31;
    for (const [char, count] of counts) {
      expect(
        count,
        `${char} appeared ${String(count)} times, expected ~${String(expected)}`,
      ).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });
});
