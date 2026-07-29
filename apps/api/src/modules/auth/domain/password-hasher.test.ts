import { describe, expect, it } from 'vitest';
import { ScryptPasswordHasher } from './password-hasher';

const hasher = new ScryptPasswordHasher();

describe('ScryptPasswordHasher', () => {
  it('verifies a correct password', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('Correct horse battery staple', stored)).toBe(false);
    expect(await hasher.verify('', stored)).toBe(false);
  });

  it('produces a different hash every time (random salt)', async () => {
    const a = await hasher.hash('same-password');
    const b = await hasher.hash('same-password');
    expect(a).not.toBe(b);
    // Both still verify: the salt travels with the hash.
    expect(await hasher.verify('same-password', a)).toBe(true);
    expect(await hasher.verify('same-password', b)).toBe(true);
  });

  it('encodes its parameters so they can be upgraded later', async () => {
    const stored = await hasher.hash('pw');
    const [algorithm, cost, blockSize, parallelization] = stored.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(cost)).toBe(32768);
    expect(Number(blockSize)).toBe(8);
    expect(Number(parallelization)).toBe(1);
    expect(stored.split('$')).toHaveLength(6);
  });

  it('handles unicode and long passwords', async () => {
    const thai = await hasher.hash('รหัสผ่านภาษาไทย');
    expect(await hasher.verify('รหัสผ่านภาษาไทย', thai)).toBe(true);

    const long = 'x'.repeat(500);
    const stored = await hasher.hash(long);
    expect(await hasher.verify(long, stored)).toBe(true);
    expect(await hasher.verify(`${long}y`, stored)).toBe(false);
  });

  it('normalizes unicode so equivalent input still verifies', async () => {
    // é as a single code point vs e + combining accent.
    const composed = 'café';
    const decomposed = 'café';
    const stored = await hasher.hash(composed);
    expect(await hasher.verify(decomposed, stored)).toBe(true);
  });

  describe('malformed stored values', () => {
    it('returns false rather than throwing', async () => {
      for (const bad of [
        '',
        'notahash',
        'scrypt$1$2$3',
        'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
        'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
        '$$$$$',
      ]) {
        expect(await hasher.verify('pw', bad)).toBe(false);
      }
    });

    it('refuses an absurd cost parameter instead of exhausting memory', async () => {
      // A hostile or corrupt row must not be able to allocate gigabytes.
      const hostile = 'scrypt$1073741824$8$1$c2FsdA==$aGFzaA==';
      expect(await hasher.verify('pw', hostile)).toBe(false);
    });
  });

  describe('needsRehash()', () => {
    it('is false for a hash at current parameters', async () => {
      expect(hasher.needsRehash(await hasher.hash('pw'))).toBe(false);
    });

    it('is true for weaker parameters, so logins transparently upgrade', () => {
      expect(hasher.needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    });

    it('is true for anything unparseable', () => {
      expect(hasher.needsRehash('garbage')).toBe(true);
    });
  });
});
