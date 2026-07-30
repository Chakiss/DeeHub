import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportError } from './error-reporting';

describe('reportError', () => {
  let written: string[] = [];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
    delete process.env['K_SERVICE'];
  });

  // Outside Cloud Run there is nothing to report to, and the Nest logger has
  // already printed a readable stack.
  it('writes nothing when not running on Cloud Run', () => {
    reportError(new Error('boom'));
    expect(written).toEqual([]);
  });

  it('writes exactly one line, so the entry is not split', () => {
    process.env['K_SERVICE'] = 'deehub-api-prod';
    reportError(new Error('boom'));

    expect(written).toHaveLength(1);
    // Cloud Logging parses ONE line of JSON. A stack printed raw would arrive
    // as a dozen unrelated entries that group into nothing.
    expect(written[0]!.endsWith('\n')).toBe(true);
    expect(written[0]!.trimEnd()).not.toContain('\n');
  });

  it('carries the stack in the message, which is what makes it group', () => {
    process.env['K_SERVICE'] = 'deehub-api-prod';
    const error = new Error('booking exploded');
    reportError(error, { requestId: 'req-1', method: 'POST', url: '/reservations' });

    const entry = JSON.parse(written[0]!) as {
      '@type': string;
      severity: string;
      message: string;
      requestId: string;
      context: { httpRequest: { method: string; responseStatusCode: number } };
    };

    expect(entry['@type']).toContain('ReportedErrorEvent');
    expect(entry.severity).toBe('ERROR');
    expect(entry.message).toContain('booking exploded');
    expect(entry.message).toContain('    at ');
    expect(entry.requestId).toBe('req-1');
    expect(entry.context.httpRequest.method).toBe('POST');
    expect(entry.context.httpRequest.responseStatusCode).toBe(500);
  });

  /**
   * Error Reporting drops an entry whose message has no frame rather than
   * grouping it badly, so a thrown string still needs a stack-shaped message.
   */
  it('synthesises a frame for something thrown that is not an Error', () => {
    process.env['K_SERVICE'] = 'deehub-api-prod';
    reportError('a bare string');

    const entry = JSON.parse(written[0]!) as { message: string };
    expect(entry.message).toContain('a bare string');
    expect(entry.message).toContain('    at ');
  });

  it('never invents a user when there is none', () => {
    process.env['K_SERVICE'] = 'deehub-api-prod';
    reportError(new Error('boom'));

    const entry = JSON.parse(written[0]!) as { context: { user: string } };
    expect(entry.context.user).toBe('');
  });
});
