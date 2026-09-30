import { describe, expect, it, vi } from 'vitest';
import { ReservationsController } from './reservations.controller';
import type { AuthenticatedRequest } from '../../../common/guards/auth.guard';

/**
 * The cancel route is guarded by `reservation:cancel`; giving money back also
 * needs `folio:post`, checked in the handler. No built-in role holds one
 * without the other, so this drives the handler with a hand-made capability set.
 */
function setup() {
  const execute = vi.fn().mockResolvedValue({
    id: 'r1',
    status: 'CANCELLED',
    releasedNights: [],
    retainedNights: [],
    refund: null,
  });
  const controller = new ReservationsController(
    {} as never,
    { execute } as never,
    {} as never,
    {} as never,
    { byId: vi.fn().mockResolvedValue({ propertyId: 'p1' }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const request = {
    capabilities: new Set(['reservation:cancel']),
    principal: { id: 'u1', email: 'u@example.test' },
    headers: {},
    ip: '127.0.0.1',
  } as unknown as AuthenticatedRequest;
  return { controller, execute, request };
}

describe('cancel without folio:post', () => {
  it('refuses a refund above 0 and does not cancel', async () => {
    const { controller, execute, request } = setup();
    await expect(
      controller.cancel(
        'p1',
        'r1',
        { version: 1, refund: { amountMinor: 100, method: 'CASH', note: 'x' } },
        request,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows a refund of 0 (the choice is only audited)', async () => {
    const { controller, execute, request } = setup();
    await controller.cancel(
      'p1',
      'r1',
      { version: 1, refund: { amountMinor: 0, method: 'CASH' } },
      request,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
