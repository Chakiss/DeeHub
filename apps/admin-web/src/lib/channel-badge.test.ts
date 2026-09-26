import { describe, expect, it } from 'vitest';
import { badgeKeyFor } from './channel-badge';

describe('badgeKeyFor', () => {
  it('trusts the connected channel first', () => {
    expect(badgeKeyFor({ source: 'DIRECT', channelType: 'GOOGLE_HOTEL' })).toBe('GOOGLE_HOTEL');
    expect(
      badgeKeyFor({ source: 'OTA', bookingSourceName: 'Agoda', channelType: 'BOOKING_COM' }),
    ).toBe('BOOKING_COM');
    expect(badgeKeyFor({ source: 'OTA', channelType: 'MOCK_OTA' })).toBe('OTA');
  });

  it('matches a named booking source by what the property called it', () => {
    expect(badgeKeyFor({ source: 'OTA', bookingSourceName: 'Booking.com' })).toBe('BOOKING_COM');
    expect(badgeKeyFor({ source: 'OTA', bookingSourceName: 'agoda extranet' })).toBe('AGODA');
    expect(badgeKeyFor({ source: 'OTA', bookingSourceName: 'Hotels.com' })).toBe('EXPEDIA');
    expect(badgeKeyFor({ source: 'OTA', bookingSourceName: 'Trip.com' })).toBe('TRIP_COM');
    expect(badgeKeyFor({ source: 'OTA', bookingSourceName: 'Some Small OTA' })).toBe('OTA');
    expect(badgeKeyFor({ source: 'TRAVEL_AGENT', bookingSourceName: 'Siam Tours' })).toBe(
      'TRAVEL_AGENT',
    );
  });

  it('falls back to the plain source', () => {
    expect(badgeKeyFor({ source: 'WALK_IN' })).toBe('WALK_IN');
    expect(badgeKeyFor({ source: 'PHONE', bookingSourceName: null, channelType: null })).toBe(
      'PHONE',
    );
    expect(badgeKeyFor({ source: 'DIRECT' })).toBe('DIRECT');
    expect(badgeKeyFor({ source: 'SOMETHING_NEW' })).toBe('UNKNOWN');
  });
});
