/**
 * Connector contract suite.
 *
 * The behaviour EVERY connector must exhibit, run here against the Mock OTA.
 * When Agoda and Booking.com arrive, they get certified by running this same
 * suite against their adapter — that is what stops each new integration
 * inventing its own semantics (architecture.md §6).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MockOta } from '@deehub/mock-ota';
import { MockOtaConnector } from './infrastructure/connectors/mock-ota.connector';
import { ConnectorRegistry } from './domain/connector.registry';
import type { AriPayload, ChannelContext } from './domain/channel-connector';
import { toIsoDate } from '@deehub/shared';

const API_KEY = 'contract-test-key';
const WEBHOOK_SECRET = 'contract-test-webhook-secret';
const HOTEL_CODE = 'HOTEL-1';

describe('connector contract (Mock OTA)', () => {
  let ota: MockOta;
  let connector: MockOtaConnector;
  let ctx: ChannelContext;

  beforeAll(async () => {
    ota = new MockOta({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET });
    const port = await ota.listen(0);
    connector = new MockOtaConnector();
    ctx = {
      channelId: 'channel-1',
      organizationId: 'org-1',
      propertyId: 'property-1',
      type: 'MOCK_OTA',
      credentials: {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        apiKey: API_KEY,
        hotelCode: HOTEL_CODE,
        webhookSecret: WEBHOOK_SECRET,
      },
      settings: {},
    };
  });

  afterAll(async () => {
    await ota.close();
  });

  afterEach(() => {
    ota.reset();
  });

  function payload(overrides: Partial<AriPayload['nights'][number]> = {}): AriPayload {
    return {
      externalRoomId: 'ROOM-DLX',
      nights: [
        {
          date: toIsoDate('2026-09-01'),
          available: 3,
          stopSell: false,
          minStay: 1,
          maxStay: null,
          closedToArrival: false,
          closedToDeparture: false,
          rates: [
            {
              externalRateId: 'RATE-BAR',
              occupancy: 2,
              amountMinor: 250000,
              currency: 'THB',
            },
          ],
          ...overrides,
        },
      ],
    };
  }

  describe('pushAri', () => {
    it('delivers availability the OTA can read back', async () => {
      const result = await connector.pushAri(ctx, payload());

      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(0);

      const stored = ota.getAri(HOTEL_CODE, 'ROOM-DLX');
      expect(stored).toHaveLength(1);
      expect(stored[0]?.avail).toBe(3);
      // The OTA's own date format, produced by the adapter.
      expect(stored[0]?.date).toBe('20260901');
    });

    it('converts minor units to the OTA decimal format without float error', async () => {
      await connector.pushAri(ctx, payload());
      expect(ota.getAri(HOTEL_CODE, 'ROOM-DLX')[0]?.rates[0]?.price).toBe('2500.00');

      ota.reset();
      // 1 satang: naive division by 100 gives 0.01 but reads back inexactly.
      await connector.pushAri(ctx, {
        externalRoomId: 'ROOM-DLX',
        nights: [
          {
            ...payload().nights[0]!,
            rates: [{ externalRateId: 'R', occupancy: 2, amountMinor: 1, currency: 'THB' }],
          },
        ],
      });
      expect(ota.getAri(HOTEL_CODE, 'ROOM-DLX')[0]?.rates[0]?.price).toBe('0.01');
    });

    it('translates restrictions into the channel vocabulary', async () => {
      await connector.pushAri(
        ctx,
        payload({
          stopSell: true,
          minStay: 3,
          maxStay: 14,
          closedToArrival: true,
          closedToDeparture: true,
        }),
      );

      const stored = ota.getAri(HOTEL_CODE, 'ROOM-DLX')[0];
      expect(stored).toMatchObject({ closed: true, minLos: 3, maxLos: 14, cta: true, ctd: true });
    });

    it('is idempotent: pushing the same state twice leaves the same result', async () => {
      await connector.pushAri(ctx, payload());
      const first = ota.getAri(HOTEL_CODE, 'ROOM-DLX')[0]?.avail;
      await connector.pushAri(ctx, payload());
      const second = ota.getAri(HOTEL_CODE, 'ROOM-DLX');

      // Absolute state, not deltas: the retry after a timeout is harmless.
      expect(second).toHaveLength(1);
      expect(second[0]?.avail).toBe(first);
    });

    it('pushes zero availability rather than omitting a sold-out night', async () => {
      await connector.pushAri(ctx, payload({ available: 0 }));
      expect(ota.getAri(HOTEL_CODE, 'ROOM-DLX')[0]?.avail).toBe(0);
    });

    it('throws on an auth failure so the job retries', async () => {
      const badCtx = { ...ctx, credentials: { ...ctx.credentials, apiKey: 'wrong' } };
      await expect(connector.pushAri(badCtx, payload())).rejects.toThrow(/rejected the ARI push/);
    });

    it('throws when the channel is temporarily unavailable', async () => {
      const flaky = new MockOta({ apiKey: API_KEY, failNextPushes: 1 });
      const port = await flaky.listen(0);
      const flakyCtx = {
        ...ctx,
        credentials: { ...ctx.credentials, baseUrl: `http://127.0.0.1:${String(port)}` },
      };
      try {
        // A 503 must surface as a failure so BullMQ backs off and retries,
        // rather than being mistaken for a successful sync.
        await expect(connector.pushAri(flakyCtx, payload())).rejects.toThrow();
        // The retry succeeds.
        await expect(connector.pushAri(flakyCtx, payload())).resolves.toMatchObject({
          accepted: 1,
        });
      } finally {
        await flaky.close();
      }
    });

    it('reports partial rejection instead of failing the whole push', async () => {
      const result = await connector.pushAri(ctx, {
        externalRoomId: 'ROOM-DLX',
        nights: [
          payload().nights[0]!,
          { ...payload().nights[0]!, available: -5 }, // the OTA refuses this
        ],
      });
      expect(result.accepted).toBe(1);
      expect(result.rejected).toBe(1);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('refuses to run without complete credentials', async () => {
      const incomplete = { ...ctx, credentials: { baseUrl: ctx.credentials['baseUrl'] ?? '' } };
      await expect(connector.pushAri(incomplete, payload())).rejects.toThrow(/requires baseUrl/);
    });
  });

  describe('testConnection', () => {
    it('reports reachable with a latency measurement', async () => {
      const health = await connector.testConnection(ctx);
      expect(health.ok).toBe(true);
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('reports unreachable rather than throwing', async () => {
      const dead = {
        ...ctx,
        credentials: { ...ctx.credentials, baseUrl: 'http://127.0.0.1:1' },
      };
      const health = await connector.testConnection(dead);
      expect(health.ok).toBe(false);
      expect(health.detail).toContain('Unreachable');
    });
  });

  describe('inbound bookings', () => {
    it('pulls bookings and maps them into domain shape', async () => {
      await ota.createBooking({
        hotelCode: HOTEL_CODE,
        roomId: 'ROOM-DLX',
        rateId: 'RATE-BAR',
        arrival: '20260901',
        departure: '20260903',
        guestName: 'Somchai P.',
        guestEmail: 'somchai@example.com',
        totalPrice: '5000.00',
        bookingRef: 'MOCK-ABC123',
      });

      const bookings = await connector.fetchReservations(ctx, new Date('2020-01-01'));

      expect(bookings).toHaveLength(1);
      expect(bookings[0]).toMatchObject({
        externalReservationId: 'MOCK-ABC123',
        externalRoomId: 'ROOM-DLX',
        // Dates normalized out of the OTA's compact format.
        checkIn: '2026-09-01',
        checkOut: '2026-09-03',
        // Price normalized into minor units.
        totalMinor: 500000,
        currency: 'THB',
        guestName: 'Somchai P.',
      });
    });

    it('keeps the raw payload for the error queue', async () => {
      await ota.createBooking({
        hotelCode: HOTEL_CODE,
        roomId: 'ROOM-DLX',
        arrival: '20260901',
        departure: '20260902',
      });
      const [booking] = await connector.fetchReservations(ctx, new Date('2020-01-01'));
      // An unmappable booking must be storable verbatim, never dropped.
      expect(booking?.raw).toBeDefined();
    });
  });

  describe('parseWebhook', () => {
    function body(bookingRef = 'MOCK-HOOK1'): string {
      return JSON.stringify({
        event: 'booking.created',
        booking: {
          bookingRef,
          hotelCode: HOTEL_CODE,
          roomId: 'ROOM-DLX',
          rateId: 'RATE-BAR',
          arrival: '20260910',
          departure: '20260912',
          adults: 2,
          children: 1,
          guestName: 'Webhook Guest',
          guestEmail: null,
          totalPrice: '3200.50',
          currency: 'THB',
          status: 'CONFIRMED',
        },
      });
    }

    it('accepts a correctly signed payload', async () => {
      const raw = body();
      const parsed = connector.parseWebhook(ctx, raw, ota.sign(raw));

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        externalReservationId: 'MOCK-HOOK1',
        checkIn: '2026-09-10',
        checkOut: '2026-09-12',
        children: 1,
        totalMinor: 320050,
      });
    });

    it('rejects a tampered payload', () => {
      const raw = body();
      const signature = ota.sign(raw);
      // Same signature, different body — the classic replay-with-edit attack.
      const tampered = raw.replace('MOCK-HOOK1', 'MOCK-EVIL');
      expect(() => connector.parseWebhook(ctx, tampered, signature)).toThrow(/Invalid webhook/);
    });

    it('rejects a missing signature', () => {
      expect(() => connector.parseWebhook(ctx, body(), undefined)).toThrow(/Invalid webhook/);
    });

    it('rejects a signature of the wrong length without throwing on comparison', () => {
      expect(() => connector.parseWebhook(ctx, body(), 'short')).toThrow(/Invalid webhook/);
    });

    it('verifies the signature BEFORE parsing the body', () => {
      // Malformed JSON with a bad signature must fail as auth, not as a parse
      // error: parsing first would mean trusting attacker-controlled input to
      // decide whether to trust it.
      expect(() => connector.parseWebhook(ctx, '{not json', 'deadbeef')).toThrow(
        /Invalid webhook signature/,
      );
    });

    it('ignores event types it does not handle', () => {
      const raw = JSON.stringify({ event: 'booking.viewed', booking: {} });
      expect(connector.parseWebhook(ctx, raw, ota.sign(raw))).toEqual([]);
    });
  });

  describe('registry', () => {
    it('resolves a connector by channel type', () => {
      const registry = new ConnectorRegistry([connector]);
      expect(registry.get('MOCK_OTA')).toBe(connector);
      expect(registry.has('AGODA')).toBe(false);
    });

    it('fails loudly for an unregistered type rather than silently not syncing', () => {
      const registry = new ConnectorRegistry([connector]);
      expect(() => registry.get('AGODA')).toThrow(/No connector registered/);
    });

    it('refuses duplicate registrations', () => {
      const registry = new ConnectorRegistry([connector]);
      expect(() => registry.register(connector)).toThrow(/already registered/);
    });
  });
});
