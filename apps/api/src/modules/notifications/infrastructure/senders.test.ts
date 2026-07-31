import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../config/env';
import { LineMessagingSender } from './line-messaging.sender';
import { ResendEmailSender } from './resend-email.sender';

function env(overrides: Partial<Env> = {}): Env {
  return overrides as Env;
}

const message = { recipient: 'guest@example.com', subject: 'Booking DH-1', body: 'Hello' };

function stubFetch(status: number, body = ''): ReturnType<typeof vi.fn> {
  const fake = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal('fetch', fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ResendEmailSender', () => {
  it('skips rather than failing when no provider is configured', async () => {
    const outcome = await new ResendEmailSender(env()).send(message);
    expect(outcome.status).toBe('SKIPPED');
    // The reason has to name the variables, or an operator is left guessing.
    expect(outcome.status === 'SKIPPED' && outcome.reason).toContain('EMAIL_API_KEY');
  });

  it('skips when a key is set but the sender address is not', async () => {
    const outcome = await new ResendEmailSender(env({ EMAIL_API_KEY: 'k' })).send(message);
    expect(outcome.status).toBe('SKIPPED');
  });

  it('sends the rendered text to the recipient', async () => {
    const fetchSpy = stubFetch(200, '{"id":"1"}');
    const outcome = await new ResendEmailSender(
      env({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'Hotel <a@b.com>' }),
    ).send(message);

    expect(outcome.status).toBe('SENT');
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      to: string[];
      text: string;
      from: string;
    };
    expect(body.to).toEqual(['guest@example.com']);
    expect(body.text).toBe('Hello');
    expect(body.from).toBe('Hotel <a@b.com>');
  });

  /*
   * The retry split is the part worth testing: a 4xx retried five times buries
   * the provider's explanation under attempt counts, and a 5xx not retried
   * loses a message to a blip.
   */
  it('treats a server error as retryable', async () => {
    stubFetch(503, 'upstream down');
    const outcome = await new ResendEmailSender(
      env({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.com' }),
    ).send(message);
    expect(outcome).toMatchObject({ status: 'FAILED', retryable: true });
  });

  it('treats a rejected request as permanent', async () => {
    stubFetch(422, 'invalid recipient');
    const outcome = await new ResendEmailSender(
      env({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.com' }),
    ).send(message);
    expect(outcome).toMatchObject({ status: 'FAILED', retryable: false });
    expect(outcome.status === 'FAILED' && outcome.error).toContain('invalid recipient');
  });

  it('treats rate limiting as "not now" rather than "never"', async () => {
    stubFetch(429);
    const outcome = await new ResendEmailSender(
      env({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.com' }),
    ).send(message);
    expect(outcome).toMatchObject({ status: 'FAILED', retryable: true });
  });

  it('treats a network failure as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.resend.com')),
    );
    const outcome = await new ResendEmailSender(
      env({ EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.com' }),
    ).send(message);
    expect(outcome).toMatchObject({ status: 'FAILED', retryable: true });
  });
});

describe('LineMessagingSender', () => {
  it('skips when no LINE channel is configured', async () => {
    const outcome = await new LineMessagingSender(env()).send(message);
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.status === 'SKIPPED' && outcome.reason).toContain('LINE_CHANNEL_TOKEN');
  });

  it('folds the subject into the text, because LINE has no subject', async () => {
    const fetchSpy = stubFetch(200, '{}');
    await new LineMessagingSender(env({ LINE_CHANNEL_TOKEN: 't' })).send({
      recipient: 'U123',
      subject: 'New booking DH-1',
      body: 'Arrives tomorrow',
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      to: string;
      messages: { text: string }[];
    };
    expect(body.to).toBe('U123');
    expect(body.messages[0]?.text).toContain('New booking DH-1');
    expect(body.messages[0]?.text).toContain('Arrives tomorrow');
  });

  it('trims a message LINE would refuse outright', async () => {
    const fetchSpy = stubFetch(200, '{}');
    await new LineMessagingSender(env({ LINE_CHANNEL_TOKEN: 't' })).send({
      recipient: 'U123',
      subject: null,
      body: 'x'.repeat(10_000),
    });

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      messages: { text: string }[];
    };
    expect(body.messages[0]?.text.length).toBeLessThanOrEqual(4_900);
  });
});
