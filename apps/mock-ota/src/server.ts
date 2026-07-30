import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * Mock OTA — a stand-in for Agoda, Booking.com and friends.
 *
 * Not a test double in the usual sense: it is a real HTTP service that speaks a
 * plausible OTA protocol, so the connector framework is exercised over the
 * network rather than against an in-process fake. It is a permanent fixture
 * (roadmap Phase 2) and becomes the harness every future connector is
 * certified against.
 *
 * Deliberately quirky in the ways real OTAs are:
 *   - its own vocabulary (`hotel_code`, `room_id`, `avail`) rather than ours
 *   - dates as `YYYYMMDD` strings
 *   - prices in MAJOR units with two decimals, not minor units
 *   - API-key auth on inbound, HMAC signature on outbound webhooks
 *
 * Those mismatches are the point: if the adapter can absorb them, the domain
 * never has to.
 */

export interface MockAriRecord {
  hotelCode: string;
  roomId: string;
  date: string;
  avail: number;
  closed: boolean;
  minLos: number;
  maxLos: number | null;
  cta: boolean;
  ctd: boolean;
  rates: { rateId: string; occupancy: number; price: string; currency: string }[];
  receivedAt: string;
}

export interface MockBooking {
  bookingRef: string;
  hotelCode: string;
  roomId: string;
  rateId: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  guestName: string;
  guestEmail: string | null;
  guestPhone: string | null;
  totalPrice: string;
  currency: string;
  status: string;
  createdAt: string;
}

export interface MockOtaOptions {
  readonly apiKey?: string;
  readonly webhookSecret?: string;
  /** Where to deliver booking notifications. Omit to disable delivery. */
  readonly webhookUrl?: string;
  /** Simulate an OTA that rejects a fraction of pushes, for retry testing. */
  readonly failNextPushes?: number;
}

export class MockOta {
  private readonly ari = new Map<string, MockAriRecord>();
  private readonly bookings = new Map<string, MockBooking>();
  private server: Server | null = null;
  private failuresRemaining: number;
  /** Every push received, for asserting on call counts in tests. */
  readonly pushLog: { hotelCode: string; roomId: string; nights: number; at: string }[] = [];
  readonly webhookDeliveries: { url: string; status: number; bookingRef: string }[] = [];

  constructor(private readonly options: MockOtaOptions = {}) {
    this.failuresRemaining = options.failNextPushes ?? 0;
  }

  private get apiKey(): string {
    return this.options.apiKey ?? 'mock-ota-dev-key';
  }

  private get webhookSecret(): string {
    return this.options.webhookSecret ?? 'mock-ota-webhook-secret';
  }

  async listen(port = 0): Promise<number> {
    this.server = createServer((req, res) => {
      // Never let a handler rejection escape: an unhandled rejection takes the
      // whole process down, and a webhook receiver being unreachable is an
      // ordinary condition, not a reason for the OTA to die.
      this.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          this.json(res, 500, { error: 'internal_error', detail: String(error) });
        } else {
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('Mock OTA failed to bind a port');
    }
    return address.port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
  }

  /** Everything the OTA currently believes about a room type. */
  getAri(hotelCode: string, roomId: string): MockAriRecord[] {
    return [...this.ari.values()]
      .filter((row) => row.hotelCode === hotelCode && row.roomId === roomId)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  getBooking(bookingRef: string): MockBooking | undefined {
    return this.bookings.get(bookingRef);
  }

  reset(): void {
    this.ari.clear();
    this.bookings.clear();
    this.pushLog.length = 0;
    this.webhookDeliveries.length = 0;
    this.failuresRemaining = this.options.failNextPushes ?? 0;
  }

  /**
   * Simulate a guest booking on the OTA. Stores the booking and, if configured,
   * delivers a signed webhook to DeeHub.
   */
  async createBooking(input: {
    hotelCode: string;
    roomId: string;
    rateId?: string | null;
    arrival: string;
    departure: string;
    adults?: number;
    children?: number;
    guestName?: string;
    guestEmail?: string | null;
    totalPrice?: string;
    currency?: string;
    bookingRef?: string;
  }): Promise<MockBooking> {
    const booking: MockBooking = {
      bookingRef: input.bookingRef ?? `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`,
      hotelCode: input.hotelCode,
      roomId: input.roomId,
      rateId: input.rateId ?? null,
      arrival: input.arrival,
      departure: input.departure,
      adults: input.adults ?? 2,
      children: input.children ?? 0,
      guestName: input.guestName ?? 'Mock Guest',
      guestEmail: input.guestEmail ?? null,
      guestPhone: null,
      totalPrice: input.totalPrice ?? '0.00',
      currency: input.currency ?? 'THB',
      status: 'CONFIRMED',
      createdAt: new Date().toISOString(),
    };
    this.bookings.set(booking.bookingRef, booking);

    if (this.options.webhookUrl) {
      // Recorded as a failed delivery rather than thrown: a real OTA keeps the
      // booking and retries even when the hotel's endpoint is down.
      await this.deliverWebhook(booking).catch((error: unknown) => {
        this.webhookDeliveries.push({
          url: this.options.webhookUrl ?? '',
          status: 0,
          bookingRef: booking.bookingRef,
        });
        process.stderr.write(
          `Webhook delivery failed for ${booking.bookingRef}: ${String(error)}\n`,
        );
      });
    }
    return booking;
  }

  /** Sign a body exactly as the webhook delivery does, for connector tests. */
  sign(body: string): string {
    return createHmac('sha256', this.webhookSecret).update(body).digest('hex');
  }

  private async deliverWebhook(booking: MockBooking): Promise<void> {
    const url = this.options.webhookUrl;
    if (!url) return;

    const body = JSON.stringify({ event: 'booking.created', booking });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Real OTAs sign the raw body; the receiver must verify before parsing.
        'x-mock-signature': this.sign(body),
      },
      body,
    });
    this.webhookDeliveries.push({
      url,
      status: response.status,
      bookingRef: booking.bookingRef,
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/health') {
      return this.json(res, 200, { status: 'ok', service: 'mock-ota' });
    }

    if (!this.authorized(req)) {
      return this.json(res, 401, { error: 'invalid_api_key' });
    }

    if (req.method === 'GET' && url.pathname === '/api/ari') {
      const hotelCode = url.searchParams.get('hotel_code') ?? '';
      const roomId = url.searchParams.get('room_id') ?? '';
      return this.json(res, 200, { ari: this.getAri(hotelCode, roomId) });
    }

    if (req.method === 'POST' && url.pathname === '/api/ari') {
      return this.receiveAri(req, res);
    }

    // Lets a developer simulate a guest booking on the OTA, which is what a
    // real channel's extranet would do. Delivers the webhook if configured.
    if (req.method === 'POST' && url.pathname === '/api/simulate/booking') {
      let input: Parameters<MockOta['createBooking']>[0];
      try {
        input = JSON.parse(await this.readBody(req)) as typeof input;
      } catch {
        return this.json(res, 400, { error: 'invalid_json' });
      }
      if (!input.hotelCode || !input.roomId || !input.arrival || !input.departure) {
        return this.json(res, 400, {
          error: 'hotelCode, roomId, arrival and departure are required',
        });
      }
      const booking = await this.createBooking(input);
      return this.json(res, 201, { booking, delivered: this.webhookDeliveries.at(-1) ?? null });
    }

    if (req.method === 'GET' && url.pathname === '/api/bookings') {
      const since = url.searchParams.get('since');
      const bookings = [...this.bookings.values()].filter(
        (booking) => !since || booking.createdAt >= since,
      );
      return this.json(res, 200, { bookings });
    }

    return this.json(res, 404, { error: 'not_found' });
  }

  private async receiveAri(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      // 503 with Retry-After is what a rate-limited OTA actually returns.
      res.setHeader('retry-after', '1');
      return this.json(res, 503, { error: 'temporarily_unavailable' });
    }

    let body: {
      hotel_code?: string;
      room_id?: string;
      nights?: {
        date?: string;
        avail?: number;
        closed?: boolean;
        min_los?: number;
        max_los?: number | null;
        cta?: boolean;
        ctd?: boolean;
        rates?: { rate_id?: string; occupancy?: number; price?: string; currency?: string }[];
      }[];
    };
    try {
      body = JSON.parse(await this.readBody(req)) as typeof body;
    } catch {
      return this.json(res, 400, { error: 'invalid_json' });
    }

    const hotelCode = body.hotel_code;
    const roomId = body.room_id;
    if (!hotelCode || !roomId || !Array.isArray(body.nights)) {
      return this.json(res, 400, { error: 'hotel_code, room_id and nights are required' });
    }

    let accepted = 0;
    const warnings: string[] = [];

    for (const night of body.nights) {
      // Real OTAs are strict about their own date format.
      if (!night.date || !/^\d{8}$/.test(night.date)) {
        warnings.push(`skipped night with invalid date ${String(night.date)}`);
        continue;
      }
      if (typeof night.avail !== 'number' || night.avail < 0) {
        warnings.push(`skipped ${night.date}: avail must be a non-negative number`);
        continue;
      }

      this.ari.set(`${hotelCode}:${roomId}:${night.date}`, {
        hotelCode,
        roomId,
        date: night.date,
        avail: night.avail,
        closed: night.closed ?? false,
        minLos: night.min_los ?? 1,
        maxLos: night.max_los ?? null,
        cta: night.cta ?? false,
        ctd: night.ctd ?? false,
        rates: (night.rates ?? []).map((rate) => ({
          rateId: rate.rate_id ?? '',
          occupancy: rate.occupancy ?? 2,
          price: rate.price ?? '0.00',
          currency: rate.currency ?? 'THB',
        })),
        receivedAt: new Date().toISOString(),
      });
      accepted += 1;
    }

    this.pushLog.push({
      hotelCode,
      roomId,
      nights: body.nights.length,
      at: new Date().toISOString(),
    });

    return this.json(res, 200, {
      accepted,
      rejected: body.nights.length - accepted,
      warnings,
    });
  }

  private authorized(req: IncomingMessage): boolean {
    const provided = req.headers['x-api-key'];
    if (typeof provided !== 'string') return false;
    const expected = Buffer.from(this.apiKey);
    const actual = Buffer.from(provided);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
