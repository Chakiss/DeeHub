import { describe, expect, it, vi } from 'vitest';
import { InvalidEmailError, normaliseEmailAddress } from './email-address';

describe('normaliseEmailAddress', () => {
  it('accepts an ordinary address', () => {
    expect(normaliseEmailAddress('owner@letschill.co.th')).toBe('owner@letschill.co.th');
  });

  it('lower-cases, so signing up as Owner@ and typing owner@ is the same person', () => {
    expect(normaliseEmailAddress('Owner@LetsChill.co.th')).toBe('owner@letschill.co.th');
  });

  it('refuses the placeholder that reached production', () => {
    expect(() => normaliseEmailAddress('<อีเมลเจ้าของโรงแรม>')).toThrow(InvalidEmailError);
  });

  /**
   * The one that matters. A zero-width space is not `\s` to JavaScript — the
   * class covers U+2000–U+200A and stops one character short — so the shape
   * check passed it and the address would have been stored twenty-two
   * characters long while printing as twenty-one. Nobody could then sign in
   * with the address they can see.
   */
  it('strips a zero-width space pasted from a chat window', () => {
    const pasted = 'sansorayos9@gmail.com​';
    expect(pasted).toHaveLength(22);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normaliseEmailAddress(pasted)).toBe('sansorayos9@gmail.com');
    vi.restoreAllMocks();
  });

  it.each([
    ['byte order mark', 'owner@hotel.co.th﻿'],
    ['zero-width joiner', 'owner‍@hotel.co.th'],
    ['left-to-right mark', '‎owner@hotel.co.th'],
  ])('strips %s', (_label, raw) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(normaliseEmailAddress(raw)).toBe('owner@hotel.co.th');
    vi.restoreAllMocks();
  });

  it('refuses a non-breaking space, which is visible enough to be a typo', () => {
    expect(() => normaliseEmailAddress('owner@hotel .co.th')).toThrow(InvalidEmailError);
  });

  it('refuses an address with Thai characters in it', () => {
    // Valid Unicode, and not something a hotel's mail server will accept.
    expect(() => normaliseEmailAddress('เจ้าของ@hotel.co.th')).toThrow(InvalidEmailError);
  });

  it.each(['', 'owner', 'owner@', '@hotel.co.th', 'owner@hotel', 'a b@hotel.co.th'])(
    'refuses %o',
    (raw) => {
      expect(() => normaliseEmailAddress(raw)).toThrow(InvalidEmailError);
    },
  );
});
