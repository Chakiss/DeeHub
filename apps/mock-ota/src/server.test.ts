import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { MockOta } from './server';

/**
 * Tests for the Mock OTA itself.
 *
 * It is a test fixture, but connectors are certified against it — so if it
 * quietly stops enforcing auth or validation, every connector would appear to
 * pass while doing the wrong thing.
 */
describe('MockOta', () => {
  let ota: MockOta;
  let baseUrl: string;

  beforeAll(async () => {
    ota = new MockOta({ apiKey: 'test-key', webhookSecret: 'test-secret' });
    const port = await ota.listen(0);
    baseUrl = `http://127.0.0.1:${String(port)}`;
  });

  afterAll(async () => {
    await ota.close();
  });

  afterEach(() => {
    ota.reset();
  });

  function ariBody(overrides: Record<string, unknown> = {}) {
    return {
      hotel_code: 'H1',
      room_id: 'R1',
      nights: [
        {
          date: '20260901',
          avail: 5,
          closed: false,
          min_los: 1,
          rates: [{ rate_id: 'RATE1', occupancy: 2, price: '2500.00', currency: 'THB' }],
          ...overrides,
        },
      ],
    };
  }

  async function post(path: string, body: unknown, apiKey = 'test-key'): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    });
  }

  it('serves health without authentication', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('rejects a missing or wrong API key', async () => {
    expect((await post('/api/ari', ariBody(), 'wrong-key')).status).toBe(401);
    const noKey = await fetch(`${baseUrl}/api/ari`, { method: 'POST', body: '{}' });
    expect(noKey.status).toBe(401);
  });

  it('stores availability and reads it back', async () => {
    const response = await post('/api/ari', ariBody());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 1, rejected: 0 });

    const stored = ota.getAri('H1', 'R1');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ avail: 5, date: '20260901' });
  });

  it('overwrites a night rather than accumulating duplicates', async () => {
    await post('/api/ari', ariBody());
    await post('/api/ari', ariBody({ avail: 2 }));
    const stored = ota.getAri('H1', 'R1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.avail).toBe(2);
  });

  it('rejects malformed nights but keeps the valid ones', async () => {
    const response = await post('/api/ari', {
      hotel_code: 'H1',
      room_id: 'R1',
      nights: [
        { date: '20260901', avail: 3 },
        { date: '2026-09-02', avail: 3 }, // wrong format for this OTA
        { date: '20260903', avail: -1 }, // negative availability
      ],
    });
    const body = (await response.json()) as { accepted: number; rejected: number };
    expect(body).toMatchObject({ accepted: 1, rejected: 2 });
    expect(ota.getAri('H1', 'R1')).toHaveLength(1);
  });

  it('requires hotel_code and room_id', async () => {
    expect((await post('/api/ari', { nights: [] })).status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const response = await fetch(`${baseUrl}/api/ari`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
      body: '{not json',
    });
    expect(response.status).toBe(400);
  });

  it('simulates temporary unavailability for retry testing', async () => {
    const flaky = new MockOta({ apiKey: 'k', failNextPushes: 2 });
    const port = await flaky.listen(0);
    try {
      const url = `http://127.0.0.1:${String(port)}/api/ari`;
      const send = () =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': 'k' },
          body: JSON.stringify(ariBody()),
        });
      expect((await send()).status).toBe(503);
      expect((await send()).status).toBe(503);
      expect((await send()).status).toBe(200);
    } finally {
      await flaky.close();
    }
  });

  it('records bookings and exposes them for pulling', async () => {
    await ota.createBooking({
      hotelCode: 'H1',
      roomId: 'R1',
      arrival: '20260901',
      departure: '20260903',
      bookingRef: 'BK-1',
    });

    const response = await fetch(`${baseUrl}/api/bookings`, {
      headers: { 'x-api-key': 'test-key' },
    });
    const body = (await response.json()) as { bookings: { bookingRef: string }[] };
    expect(body.bookings.map((b) => b.bookingRef)).toContain('BK-1');
  });

  it('signs webhook bodies deterministically', () => {
    const body = '{"hello":"world"}';
    expect(ota.sign(body)).toBe(ota.sign(body));
    expect(ota.sign(body)).not.toBe(ota.sign('{"hello":"there"}'));
  });

  it('delivers a signed webhook when configured', async () => {
    const received: { body: string; signature: string | null }[] = [];
    const receiver = createWebhookCollector(received);
    const port = await receiver.listen();

    const withHook = new MockOta({
      apiKey: 'k',
      webhookSecret: 'hook-secret',
      webhookUrl: `http://127.0.0.1:${String(port)}/hook`,
    });
    try {
      await withHook.createBooking({
        hotelCode: 'H1',
        roomId: 'R1',
        arrival: '20260901',
        departure: '20260902',
        bookingRef: 'BK-HOOK',
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.body).toContain('BK-HOOK');
      // The receiver must be able to verify what it got.
      expect(received[0]?.signature).toBe(withHook.sign(received[0]?.body ?? ''));
      expect(withHook.webhookDeliveries[0]).toMatchObject({ status: 200 });
    } finally {
      await receiver.close();
      await withHook.close();
    }
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/nope`, { headers: { 'x-api-key': 'test-key' } });
    expect(response.status).toBe(404);
  });
});

/** Minimal collector so the webhook test can assert on what was delivered. */
function createWebhookCollector(sink: { body: string; signature: string | null }[]) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      sink.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: (req.headers['x-mock-signature'] as string | undefined) ?? null,
      });
      res.writeHead(200).end('{}');
    });
  });

  return {
    async listen(): Promise<number> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (typeof address === 'string' || address === null) throw new Error('no port');
      return address.port;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
