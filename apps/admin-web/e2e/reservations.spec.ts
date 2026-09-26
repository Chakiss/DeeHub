import { expect, test } from '@playwright/test';
import { login, openForSale, testData } from './helpers';

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
    // Rooms named so no other spec's /201/-style pattern can match them.
    await addRoom(request, token, '901');
    await addRoom(request, token, '902');
    await openForSale(request, token, '2030-08-01', '2030-08-06');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);

    await page.getByLabel('Check-in').fill('2030-08-01');
    await page.getByLabel('Check-out').fill('2030-08-03');
    await page.getByLabel('Name', { exact: true }).fill('Kanya Room Picker');

    // The picker lists what is free for those nights, this type first.
    const roomSelect = page.getByLabel('Room number (optional)');
    await expect(roomSelect.locator('option', { hasText: '901' })).toHaveCount(1);
    await roomSelect.selectOption({ label: '901' });
    await page.getByRole('button', { name: 'Create booking' }).click();

    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);
    await expect(page.getByText('901')).toBeVisible();

    // Moving the guest from the booking itself, not from the stay view.
    await page.getByRole('button', { name: 'Change room' }).click();
    const picker = page.getByRole('combobox', { name: 'Room', exact: true });
    // 1101 is this very stay's room and stays choosable as "current"; 1102 is
    // free.
    await expect(picker.locator('option', { hasText: '902' })).toHaveCount(1);
    await picker.selectOption({ label: '902' });
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('button', { name: 'Change room' })).toBeVisible();
    await expect(page.getByText('902')).toBeVisible();
    await expect(page.getByText('901')).toHaveCount(0);
  });

  /**
   * The name a desk types at 05:49 is rarely the one the guest would sign.
   * Corrected in place — same code, same folio — and the stay view reads the
   * new name, because that is where the desk actually looks for it.
   */
  test('corrects the booker in place, and the stay view shows the new name', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token, '2030-10-01', '2030-10-04');
    const typo = `Wechat ${Date.now().toString(36)}`;
    await book(request, token, typo, '2030-10-01', '2030-10-03');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations?q=${encodeURIComponent(typo)}`);
    // The row links by code, not by name.
    await page
      .getByRole('row', { name: new RegExp(typo) })
      .getByRole('link')
      .first()
      .click();
    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.getByRole('form', { name: 'Correct the booker' });
    const fixed = `Xiao Yu ${Date.now().toString(36)}`;
    await form.getByLabel('Guest', { exact: true }).fill(fixed);
    await form.getByLabel('Email').fill('xiaoyu@example.com');
    await form.getByLabel('Phone').fill('+66 81 234 5678');
    await form.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('status')).toContainText('saved');
    await expect(page.getByText(fixed)).toBeVisible();
    await expect(page.getByText('+66 81 234 5678')).toBeVisible();
    await expect(page.getByText(typo)).toHaveCount(0);

    await page.goto(`/properties/${data.propertyId}/stay-view?from=2030-10-01`);
    await expect(page.getByRole('listitem').filter({ hasText: fixed })).toBeVisible();
  });

  test('a room taken on those nights is not offered', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await addRoom(request, token, '903');
    await openForSale(request, token, '2030-08-01', '2030-08-06');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);
    await page.getByLabel('Check-in').fill('2030-08-03');
    await page.getByLabel('Check-out').fill('2030-08-05');
    await page.getByLabel('Name', { exact: true }).fill('First In');
    await page.getByLabel('Room number (optional)').selectOption({ label: '903' });
    await page.getByRole('button', { name: 'Create booking' }).click();
    await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);

    await page.goto(`/properties/${data.propertyId}/reservations/new`);
    await page.getByLabel('Check-in').fill('2030-08-04');
    await page.getByLabel('Check-out').fill('2030-08-06');
    const roomSelect = page.getByLabel('Room number (optional)');
    await expect(roomSelect.locator('option', { hasText: 'Assign later' })).toHaveCount(1);
    await expect(roomSelect.locator('option', { hasText: '903' })).toHaveCount(0);

    // Leaving on the 5th frees it for a 5th arrival — nights are half-open.
    await page.getByLabel('Check-in').fill('2030-08-05');
    await page.getByLabel('Check-out').fill('2030-08-06');
    await expect(roomSelect.locator('option', { hasText: '903' })).toHaveCount(1);
  });
});
