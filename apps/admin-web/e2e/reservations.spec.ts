import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Creates a booking through the API so the list has something real to show.
 * Uses the dashboard's own session, so this also exercises the BFF path.
 */
async function book(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  guestName: string,
  checkIn: string,
  checkOut: string,
): Promise<void> {
  const data = testData();
  const response = await request.post(
    `${process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1'}/properties/${data.propertyId}/reservations`,
    {
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
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

/** A physical room, so the booking form has something to put the guest in. */
async function addRoom(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  roomNumber: string,
): Promise<void> {
  const data = testData();
  const response = await request.post(
    `${process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1'}/properties/${data.propertyId}/rooms`,
    {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { roomTypeId: data.roomTypeId, roomNumber },
    },
  );
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function apiToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const data = testData();
  const response = await request.post(
    `${process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1'}/auth/login`,
    {
      data: {
        organizationSlug: data.organizationSlug,
        email: data.managerEmail,
        password: 'dashboard-e2e-password',
      },
    },
  );
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

test.describe('reservations', () => {
  test('lists bookings with a per-row summary', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await book(request, token, 'Ploy Wattana', '2030-04-01', '2030-04-03');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations`);

    const row = page.locator('tbody tr').filter({ hasText: 'Ploy Wattana' });
    await expect(row).toBeVisible();
    // Rooms and nights come from correlated subqueries that once silently
    // returned zero — assert them explicitly.
    await expect(row).toContainText('2030-04-01');
    await expect(row).toContainText('confirmed');
    await expect(row).toContainText('THB');
  });

  test('search narrows the list', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await book(request, token, 'Somchai Prasert', '2030-04-02', '2030-04-03');
    await book(request, token, 'Nattapong S', '2030-04-02', '2030-04-03');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations`);

    await page.getByPlaceholder(/Search by reference/).fill('Somchai');
    await page.getByPlaceholder(/Search by reference/).press('Enter');

    await expect(page.locator('tbody tr').filter({ hasText: 'Somchai Prasert' })).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: 'Nattapong S' })).toHaveCount(0);
  });

  test('status filter resets paging rather than carrying a stale cursor', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    // A syntactically valid cursor. A malformed one is rejected with 422 by
    // design, so the page would never render and the test would prove nothing.
    const cursor = Buffer.from(
      JSON.stringify({ c: '2030-01-01T00:00:00.000Z', i: data.propertyId }),
    ).toString('base64url');
    await page.goto(`/properties/${data.propertyId}/reservations?cursor=${cursor}`);

    // A filter change must drop the cursor; keeping it would page into a
    // different result set and skip rows.
    //
    // Scoped to the page body: the header carries a language switcher, so a
    // bare select matches two things — and the filters row has two of its
    // own (status, then source).
    await page.getByRole('main').getByRole('combobox').first().selectOption('CONFIRMED');
    await expect(page).toHaveURL(/status=CONFIRMED/);
    await expect(page).not.toHaveURL(/cursor=/);
  });

  test('shows an empty state rather than a blank table', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations?q=nobody-by-this-name`);
    await expect(page.getByText(/No reservations match/)).toBeVisible();
  });
  test('takes a booking with the room chosen up front, then moves it', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    await addRoom(request, token, '1101');
    await addRoom(request, token, '1102');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);

    await page.getByLabel('Check-in').fill('2030-04-01');
    await page.getByLabel('Check-out').fill('2030-04-03');
    await page.getByLabel('Name', { exact: true }).fill('Kanya Room Picker');

    // The picker lists what is free for those nights, this type first.
    const roomSelect = page.getByLabel('Room number (optional)');
    await expect(roomSelect.locator('option', { hasText: '1101' })).toHaveCount(1);
    await roomSelect.selectOption({ label: '1101' });
    await page.getByRole('button', { name: 'Create booking' }).click();

    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);
    await expect(page.getByText('1101')).toBeVisible();

    // Moving the guest from the booking itself, not from the stay view.
    await page.getByRole('button', { name: 'Change room' }).click();
    const picker = page.getByRole('combobox', { name: 'Room', exact: true });
    // 1101 is this very stay's room and stays choosable as "current"; 1102 is
    // free.
    await expect(picker.locator('option', { hasText: '1102' })).toHaveCount(1);
    await picker.selectOption({ label: '1102' });
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('button', { name: 'Change room' })).toBeVisible();
    await expect(page.getByText('1102')).toBeVisible();
    await expect(page.getByText('1101')).toHaveCount(0);
  });

  test('a room taken on those nights is not offered', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await addRoom(request, token, '1201');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);
    await page.getByLabel('Check-in').fill('2030-04-03');
    await page.getByLabel('Check-out').fill('2030-04-05');
    await page.getByLabel('Name', { exact: true }).fill('First In');
    await page.getByLabel('Room number (optional)').selectOption({ label: '1201' });
    await page.getByRole('button', { name: 'Create booking' }).click();
    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);

    await page.goto(`/properties/${data.propertyId}/reservations/new`);
    await page.getByLabel('Check-in').fill('2030-04-04');
    await page.getByLabel('Check-out').fill('2030-04-06');
    const roomSelect = page.getByLabel('Room number (optional)');
    await expect(roomSelect.locator('option', { hasText: 'Assign later' })).toHaveCount(1);
    await expect(roomSelect.locator('option', { hasText: '1201' })).toHaveCount(0);

    // Leaving on the 5th frees it for a 5th arrival — nights are half-open.
    await page.getByLabel('Check-in').fill('2030-04-05');
    await page.getByLabel('Check-out').fill('2030-04-06');
    await expect(roomSelect.locator('option', { hasText: '1201' })).toHaveCount(1);
  });
});
