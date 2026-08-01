import { describe, expect, it } from 'vitest';
import {
  RESET_TOKEN_TTL_SECONDS,
  classifyResetToken,
  generateResetToken,
  hashResetToken,
  resetLink,
  type StoredResetToken,
} from './password-reset';

const NOW = new Date('2026-08-01T10:00:00Z');

function stored(overrides: Partial<StoredResetToken> = {}): StoredResetToken {
  return {
    id: 'token-1',
    userId: 'user-1',
    organizationId: 'org-1',
    expiresAt: new Date(NOW.getTime() + RESET_TOKEN_TTL_SECONDS * 1000),
    consumedAt: null,
    invalidatedAt: null,
    ...overrides,
  };
}

describe('generateResetToken', () => {
  it('never returns the same token twice', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateResetToken().token));
    expect(tokens.size).toBe(100);
  });

  it('returns the hash of the token it generated', () => {
    const { token, tokenHash } = generateResetToken();
    expect(tokenHash).toBe(hashResetToken(token));
  });

  it('produces a token that survives a URL round trip unchanged', () => {
    // base64url, not base64: a `+` or `/` in a query string is a token the
    // person pastes back in a different form than the one that was hashed.
    const { token } = generateResetToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    const parsed = new URL(resetLink('https://admin.example.com', token));
    expect(parsed.searchParams.get('token')).toBe(token);
  });
});

describe('resetLink', () => {
  it('points at the reset page on the given host', () => {
    const link = resetLink('https://admin.example.com', 'abc');
    expect(link).toBe('https://admin.example.com/reset-password?token=abc');
  });

  it('ignores a path on the base url rather than nesting under it', () => {
    // A base of ".../dashboard" must not produce ".../dashboard/reset-password":
    // the route is absolute, and a link to a page that does not exist is a
    // person who stays locked out.
    expect(resetLink('https://admin.example.com/dashboard', 'abc')).toBe(
      'https://admin.example.com/reset-password?token=abc',
    );
  });
});

describe('classifyResetToken', () => {
  it('accepts a live token', () => {
    expect(classifyResetToken(stored(), NOW).state).toBe('VALID');
  });

  it('refuses a token nobody issued', () => {
    expect(classifyResetToken(null, NOW).state).toBe('UNKNOWN');
  });

  it('refuses one that has already been spent', () => {
    expect(classifyResetToken(stored({ consumedAt: NOW }), NOW).state).toBe('SPENT');
  });

  it('refuses one a later reset invalidated', () => {
    expect(classifyResetToken(stored({ invalidatedAt: NOW }), NOW).state).toBe('SPENT');
  });

  it('refuses one that has expired', () => {
    const expired = stored({ expiresAt: new Date(NOW.getTime() - 1) });
    expect(classifyResetToken(expired, NOW).state).toBe('EXPIRED');
  });

  it('treats the instant of expiry as expired, not valid', () => {
    // The boundary decides a real case: a link clicked exactly on the hour.
    // Inclusive here means the window is never longer than advertised.
    const onTheDot = stored({ expiresAt: NOW });
    expect(classifyResetToken(onTheDot, NOW).state).toBe('EXPIRED');
  });

  it('reports a spent token as spent even after it would have expired', () => {
    // Order matters for the audit trail: "somebody used this" is the more
    // interesting fact than "and it would be stale by now anyway".
    const both = stored({ consumedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) });
    expect(classifyResetToken(both, NOW).state).toBe('SPENT');
  });
});
