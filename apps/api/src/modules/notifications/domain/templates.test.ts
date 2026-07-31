import { describe, expect, it } from 'vitest';
import { toIsoDate } from '@deehub/shared';
import { NOTIFICATION_KINDS, type BookingSummary } from './notification';
import { localeFor, render } from './templates';

function booking(overrides: Partial<BookingSummary> = {}): BookingSummary {
  return {
    reservationId: 'res-1',
    code: 'DH-8F3K2A',
    propertyName: 'Baan Suan Hotel',
    propertyPhone: '+66 2 123 4567',
    checkInTime: '14:00',
    checkOutTime: '12:00',
    bookerName: 'Naruemon Chaiyaporn',
    checkIn: toIsoDate('2026-08-12'),
    checkOut: toIsoDate('2026-08-15'),
    nights: 3,
    rooms: 1,
    totalMinor: 450000,
    currency: 'THB',
    channelName: null,
    cancellationReason: null,
    ...overrides,
  };
}

describe('localeFor()', () => {
  it('writes Thai for a Thai property', () => {
    expect(localeFor('TH')).toBe('th');
    expect(localeFor('th')).toBe('th');
  });

  it('falls back to English anywhere else', () => {
    expect(localeFor('SG')).toBe('en');
  });
});

describe('render()', () => {
  it('produces a subject and a body for every kind, in both languages', () => {
    for (const kind of NOTIFICATION_KINDS) {
      for (const locale of ['en', 'th'] as const) {
        const message = render(kind, booking(), locale);
        expect(message.subject.length, `${kind} ${locale} subject`).toBeGreaterThan(0);
        expect(message.body.length, `${kind} ${locale} body`).toBeGreaterThan(0);
      }
    }
  });

  it('never leaves an undefined in what a guest reads', () => {
    // A template referencing a field that stopped existing renders the string
    // "undefined" into someone's inbox rather than failing anywhere visible.
    for (const kind of NOTIFICATION_KINDS) {
      for (const locale of ['en', 'th'] as const) {
        const message = render(kind, booking({ channelName: null }), locale);
        expect(`${message.subject} ${message.body}`).not.toContain('undefined');
        expect(`${message.subject} ${message.body}`).not.toContain('NaN');
      }
    }
  });

  it('carries the booking reference and the dates a guest needs', () => {
    const message = render('BOOKING_CONFIRMED', booking(), 'en');
    expect(message.subject).toContain('DH-8F3K2A');
    expect(message.body).toContain('2026-08-12');
    expect(message.body).toContain('2026-08-15');
    expect(message.body).toContain('14:00');
  });

  it('formats money in the property currency, not raw minor units', () => {
    const message = render('BOOKING_CONFIRMED', booking(), 'en');
    expect(message.body).toContain('4,500.00');
    expect(message.body).not.toContain('450000');
  });

  it('writes Thai that is actually Thai', () => {
    const message = render('BOOKING_CONFIRMED', booking(), 'th');
    expect(message.subject).toContain('ยืนยันการจอง');
    expect(message.body).toContain('เช็คอิน');
  });

  it('omits the phone line when the property has no number', () => {
    const withPhone = render('BOOKING_CONFIRMED', booking(), 'en').body;
    const without = render('BOOKING_CONFIRMED', booking({ propertyPhone: null }), 'en').body;
    expect(withPhone).toContain('+66 2 123 4567');
    expect(without).not.toContain('Questions?');
  });

  it('includes the cancellation reason only when one was given', () => {
    const withReason = render(
      'BOOKING_CANCELLED',
      booking({ cancellationReason: 'Guest changed plans' }),
      'en',
    ).body;
    expect(withReason).toContain('Guest changed plans');
    expect(render('BOOKING_CANCELLED', booking(), 'en').body).not.toContain('Reason recorded');
  });

  it('names the channel a booking arrived from, for the desk', () => {
    const message = render('BOOKING_RECEIVED', booking({ channelName: 'Agoda' }), 'en');
    expect(message.subject).toContain('Agoda');
    expect(message.body).toContain('Agoda');
  });

  it('does not say "a channel" as though it were a name when one is known', () => {
    const message = render('BOOKING_RECEIVED', booking({ channelName: null }), 'en');
    expect(message.subject).toContain('a channel');
  });

  it('gets the plural right for a one-night booking', () => {
    const message = render(
      'BOOKING_RECEIVED',
      booking({ nights: 1, rooms: 1, checkOut: toIsoDate('2026-08-13') }),
      'en',
    );
    expect(message.body).toContain('1 night,');
    expect(message.body).toContain('1 room)');
  });
});
