import { describe, expect, it } from 'vitest';
import { toIsoDate } from '@deehub/shared';
import type { AriPayload } from '../../../domain/channel-connector';
import { buildAriDocuments, parseUploadResponse } from './ari-xml';
import { buildHotelList } from './hotel-list-xml';
import { buildPropertyData } from './property-data-xml';
import { runs } from './xml';

const night = (date: string, overrides: Partial<AriPayload['nights'][number]> = {}) => ({
  date: toIsoDate(date),
  available: 2,
  stopSell: false,
  minStay: 1,
  maxStay: null,
  closedToArrival: false,
  closedToDeparture: false,
  rates: [
    {
      externalRateId: 'BAR',
      occupancy: 2,
      amountMinor: 100000,
      grossMinor: 117700,
      currency: 'THB',
    },
  ],
  ...overrides,
});

describe('Google ARI documents', () => {
  const now = new Date('2026-09-23T10:00:00Z');

  it('collapses a run of equal nights into one rate, one availability and one inventory element', () => {
    const payload: AriPayload = {
      externalRoomId: 'BUN',
      nights: [night('2026-10-01'), night('2026-10-02'), night('2026-10-03')],
    };
    const docs = buildAriDocuments('hotel-1', payload, now);

    expect(docs.rates).toContain('HotelCode="hotel-1"');
    expect(docs.rates.match(/<RateAmountMessage>/g)).toHaveLength(1);
    expect(docs.rates).toContain(
      'Start="2026-10-01" End="2026-10-03" InvTypeCode="BUN" RatePlanCode="BAR"',
    );
    // Net and all-in, both, per occupancy; decimals, not minor units.
    expect(docs.rates).toContain(
      'AmountBeforeTax="1000.00" AmountAfterTax="1177.00" CurrencyCode="THB" NumberOfGuests="2"',
    );

    expect(docs.availability).toContain('Status="Open" Restriction="Master"');
    expect(docs.availability).toContain('Time="1" MinMaxMessageType="SetMinLOS"');
    expect(docs.inventory).toContain('CountType="2" Count="2"');
    expect(docs.inventory.match(/<Inventory>/g)).toHaveLength(1);
  });

  it('closes a stopped night and a sold-out night, and removes a price that is gone', () => {
    const payload: AriPayload = {
      externalRoomId: 'BUN',
      nights: [
        night('2026-10-01', { stopSell: true }),
        night('2026-10-02', { available: 0 }),
        night('2026-10-03', { rates: [], closedToArrival: true, minStay: 2, maxStay: 5 }),
      ],
    };
    const docs = buildAriDocuments('hotel-1', payload, now);
    expect(docs.availability).toContain(
      'Start="2026-10-01" End="2026-10-02" InvTypeCode="BUN" RatePlanCode="BAR"/><RestrictionStatus Status="Close" Restriction="Master"',
    );
    expect(docs.availability).toContain(
      'Start="2026-10-03" End="2026-10-03" InvTypeCode="BUN" RatePlanCode="BAR"/><RestrictionStatus Status="Close" Restriction="Arrival"',
    );
    expect(docs.availability).toContain('Time="5" MinMaxMessageType="SetMaxLOS"');
    expect(docs.rates).toContain(
      'Start="2026-10-03" End="2026-10-03" InvTypeCode="BUN" RatePlanCode="BAR"/><Rates><Rate NotifType="Remove"/>',
    );
    expect(docs.inventory).toContain('Count="0"');
  });

  it('escapes what a hotel might type', () => {
    const payload: AriPayload = { externalRoomId: 'B&B <suite>', nights: [night('2026-10-01')] };
    const docs = buildAriDocuments('hotel-1', payload, now);
    expect(docs.rates).toContain('InvTypeCode="B&amp;B &lt;suite&gt;"');
  });

  it("reads Google's answer", () => {
    expect(parseUploadResponse('<Response><Success/></Response>')).toEqual({
      success: true,
      warnings: [],
      errors: [],
    });
    const failed = parseUploadResponse(
      '<Response><Errors><Error code="1">Unknown hotel</Error></Errors><Warnings><Warning>late</Warning></Warnings></Response>',
    );
    expect(failed.success).toBe(false);
    expect(failed.errors).toEqual(['Unknown hotel']);
    expect(failed.warnings).toEqual(['late']);
  });
});

describe('property data and hotel list', () => {
  it('describes rooms and packages under our own ids', () => {
    const xml = buildPropertyData(
      'deehub',
      'hotel-1',
      [{ externalRoomId: 'BUN', name: 'Bungalow', description: null, maxOccupancy: 2 }],
      [
        {
          externalRateId: 'BAR',
          name: 'Best Available',
          description: null,
          refundable: true,
          breakfastIncluded: false,
        },
      ],
      'en',
      new Date('2026-09-23T10:00:00Z'),
    );
    expect(xml).toContain('partner="deehub"');
    expect(xml).toContain('<PropertyDataSet action="overlay"><Property>hotel-1</Property>');
    expect(xml).toContain('<RoomID>BUN</RoomID><Name><Text text="Bungalow" language="en"/></Name>');
    expect(xml).toContain('<Capacity>2</Capacity>');
    expect(xml).toContain('<PackageID>BAR</PackageID>');
    expect(xml).toContain('<Refundable available="true"/><BreakfastIncluded>0</BreakfastIncluded>');
  });

  it('lists a property with the address Google matches on', () => {
    const xml = buildHotelList([
      {
        id: 'hotel-1',
        name: "The Let's Chill",
        addressLine1: '60/11 Huai Yai',
        addressLine2: null,
        city: 'Bang Lamung',
        postalCode: '20150',
        country: 'TH',
        latitude: 12.9236,
        longitude: 100.8825,
        phone: '063 548 5456',
      },
    ]);
    expect(xml).toContain('<language>en</language>');
    expect(xml).toContain('<id>hotel-1</id><name>The Let&#39;s Chill</name>'.replace('&#39;', "'"));
    expect(xml).toContain('<component name="addr1">60/11 Huai Yai</component>');
    expect(xml).toContain('<latitude>12.9236</latitude><longitude>100.8825</longitude>');
    expect(xml).toContain('<phone type="main">063 548 5456</phone>');
  });
});

describe('runs', () => {
  it('breaks a run at a gap and at a changed value', () => {
    const out = runs(
      ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05'],
      (date) => (date === '2026-10-05' ? 'b' : 'a'),
      (a, b) => a === b,
    );
    expect(out).toEqual([
      { start: '2026-10-01', end: '2026-10-02', value: 'a' },
      { start: '2026-10-04', end: '2026-10-04', value: 'a' },
      { start: '2026-10-05', end: '2026-10-05', value: 'b' },
    ]);
  });
});
