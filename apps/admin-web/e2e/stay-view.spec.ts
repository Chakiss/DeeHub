import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

const API = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

async function apiToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const data = testData();
  const response = await request.post(`${API}/auth/login`, {
    data: {
      organizationSlug: data.organizationSlug,
      email: data.managerEmail,
      password: 'dashboard-e2e-password',
    },
  });
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/** Its own booking, so the test does not depend on what other specs seeded. */
async function book(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  guestName: string,
  checkIn: string,
  checkOut: string,
): Promise<void> {
  const data = testData();
  const response = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: {
      source: 'WALK_IN',
      booker: { name: guestName },
      stays: [
        {
          roomTypeId: data.roomTypeId,
          ratePlanId: data.ratePlanId,
          checkIn,
          checkOut,
          adults: 2,
        },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** Options read "201 — Deluxe Double", so pick by value rather than by label. */
async function selectRoom(
  dialog: import('@playwright/test').Locator,
  roomNumber: string,
): Promise<void> {
  const value = await dialog
    .locator('option', { hasText: roomNumber })
    .first()
    .getAttribute('value');
  await dialog.getByLabel('Choose a room').selectOption(value ?? '');
}

/**
 * Rooms and the stay view.
 *
 * The point of the last test is the one thing this screen must never do:
 * adding rooms cannot change what the hotel can sell. A room is a place to
 * sleep; allotment is a commercial decision (ADR-0002).
 */
test.describe.configure({ mode: 'serial' });

test.describe('rooms and stay view', () => {
  test('adds rooms and sets housekeeping status', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rooms`);
    // Said before anyone can act on it — this is the screen people expect to
    // control availability, and it does not.
    await expect(page.getByText(/Room count does not set availability/i)).toBeVisible();

    for (const roomNumber of ['201', '202']) {
      await page.getByRole('button', { name: 'Add room' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add room' });
      await dialog.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
      await dialog.getByLabel('Room number').fill(roomNumber);
      await dialog.getByLabel('Floor').fill('2');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('row', { name: new RegExp(roomNumber) })).toBeVisible();
    }

    await page
      .getByRole('row', { name: /201/ })
      .getByLabel(/Housekeeping/)
      .selectOption('DIRTY');
    await expect
      .poll(async () => page.getByRole('row', { name: /201/ }).textContent())
      .toContain('Dirty');
  });

  test('refuses a duplicate room number', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rooms`);
    await page.getByRole('button', { name: 'Add room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add room' });
    await dialog.getByLabel('Room number').fill('201');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog.getByRole('alert')).toContainText(/already used/i);
  });

  test('lists a booking that has no room, then assigns it', async ({ page, request }) => {
    const data = testData();
    const guest = `Stayview ${Date.now().toString(36)}`;
    await book(request, await apiToken(request), guest, data.dates[0]!, data.dates[2]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/stay-view?from=${data.dates[0]}`);
    await expect(page.getByRole('heading', { name: 'Stay view' })).toBeVisible();

    // Booked, in the window, nowhere to sleep — the front desk's worklist.
    const worklist = page.getByRole('listitem').filter({ hasText: guest });
    await expect(worklist).toBeVisible();

    await worklist.getByRole('button', { name: 'Assign' }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(guest) });
    await selectRoom(dialog, '201');
    await dialog.getByRole('button', { name: 'Assign' }).click();

    // It leaves the worklist and appears on the room's row.
    await expect(worklist).toHaveCount(0);
    await expect(page.getByRole('row', { name: /201/ })).toContainText(guest);
  });

  /**
   * The database refuses two bookings in one room on overlapping nights, and
   * the message has to name the room rather than surface a constraint.
   */
  test('refuses to put a second guest in an occupied room', async ({ page, request }) => {
    const data = testData();
    const guest = `Clash ${Date.now().toString(36)}`;
    await book(request, await apiToken(request), guest, data.dates[1]!, data.dates[3]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/stay-view?from=${data.dates[0]}`);

    const worklist = page.getByRole('listitem').filter({ hasText: guest });
    await worklist.getByRole('button', { name: 'Assign' }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(guest) });
    await selectRoom(dialog, '201');
    await dialog.getByRole('button', { name: 'Assign' }).click();

    await expect(dialog.getByRole('alert')).toContainText('201');
  });

  /**
   * The guarantee this whole module rests on. Rooms exist for housekeeping and
   * assignment; allotment is what the property chose to sell. Two rooms were
   * just added, and availability must be exactly what it was.
   */
  test('adding rooms does not change what can be sold', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[0]}`);
    const deluxe = page.locator('tbody tr').filter({ hasText: 'Deluxe Double' });
    // Still the seeded allotment of 5, not the 2 physical rooms that exist.
    await expect(deluxe).toContainText('0/5');
  });

  test('a front-desk user cannot add rooms', async ({ page }) => {
    const data = testData();
    await login(page, data.frontDeskEmail);

    await page.goto(`/properties/${data.propertyId}/rooms`);
    await expect(page.getByRole('button', { name: 'Add room' })).toHaveCount(0);
  });
});
