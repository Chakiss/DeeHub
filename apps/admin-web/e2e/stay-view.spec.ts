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
): Promise<{ stayId: string }> {
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
  const body = (await response.json()) as { stays: { id: string }[] };
  return { stayId: body.stays[0]!.id };
}

/**
 * Open allotment and price a range.
 *
 * The fixture only seeds far-future dates, so a test that needs to book for
 * TODAY — check-in refuses a future arrival — has to open today first, exactly
 * as a hotel would.
 */
async function openForSale(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  from: string,
  to: string,
): Promise<void> {
  const data = testData();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const inventory = await request.patch(`${API}/properties/${data.propertyId}/inventory`, {
    headers,
    data: { updates: [{ roomTypeId: data.roomTypeId, from, to, allotment: 3 }] },
  });
  expect(inventory.ok(), await inventory.text()).toBeTruthy();

  const rates = await request.patch(`${API}/properties/${data.propertyId}/rates`, {
    headers,
    data: {
      updates: [
        {
          ratePlanId: data.ratePlanId,
          from,
          to,
          prices: [
            { occupancy: 1, amount: 90000 },
            { occupancy: 2, amount: 120000 },
          ],
        },
      ],
    },
  });
  expect(rates.ok(), await rates.text()).toBeTruthy();
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

  test('renames a room and its floor in place', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/rooms`);

    await page.getByRole('button', { name: 'Add room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add room' });
    await dialog.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
    await dialog.getByLabel('Room number').fill('X1');
    await dialog.getByRole('button', { name: 'Save' }).click();
    const row = page.getByRole('row', { name: /X1/ });
    await expect(row).toBeVisible();

    // The numbers a property was set up with are rarely the ones on the doors.
    await row.getByRole('button', { name: 'Rename X1' }).click();
    // The row's text becomes inputs while editing, so locate those directly;
    // the add dialog with the same labels is closed.
    await page.getByLabel('Room number', { exact: true }).fill('X9');
    await page.getByLabel('Floor', { exact: true }).fill('9');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    const renamed = page.getByRole('row', { name: /X9/ });
    await expect(renamed).toBeVisible();
    await expect(renamed).toContainText('9');
    await expect(page.getByRole('row', { name: /X1/ })).toHaveCount(0);
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

    // It leaves the worklist and appears on the room's row — under its room
    // type's heading, which is how the grid is now read.
    await expect(worklist).toHaveCount(0);
    await expect(page.getByRole('row', { name: /201/ })).toContainText(guest);
    const heading = page.getByRole('button', { name: /Deluxe Double/ }).first();
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await heading.click();
    await expect(page.getByRole('row', { name: /201/ })).toHaveCount(0);
    await heading.click();
    await expect(page.getByRole('row', { name: /201/ })).toBeVisible();
  });

  /**
   * The dialog offers only rooms free on the stay's nights — 201 is held by
   * the previous test's guest — and when two desks are offered the same room
   * at once, the database refuses the second with a message naming the room
   * rather than surfacing a constraint.
   */
  test('offers only free rooms, and refuses a room taken while the dialog was open', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    // Two bookings on the shared window would sell a night out for the specs
    // after this one, so these get nights of their own.
    await openForSale(request, token, '2030-09-01', '2030-09-06');
    const guest = `Clash ${Date.now().toString(36)}`;
    await book(request, token, guest, '2030-09-02', '2030-09-04');
    const rival = await book(
      request,
      token,
      `Rival ${Date.now().toString(36)}`,
      '2030-09-02',
      '2030-09-04',
    );

    const rooms = (await (
      await request.get(`${API}/properties/${data.propertyId}/rooms`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { items: { id: string; roomNumber: string }[] };
    const roomId = (roomNumber: string) =>
      rooms.items.find((room) => room.roomNumber === roomNumber)!.id;
    const moveRival = async (roomNumber: string) => {
      const moved = await request.patch(
        `${API}/properties/${data.propertyId}/stays/${rival.stayId}/room`,
        {
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          data: { roomId: roomId(roomNumber) },
        },
      );
      expect(moved.ok(), await moved.text()).toBeTruthy();
    };

    // The rival is in 201 before the dialog opens: 201 must not be offered.
    await moveRival('201');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/stay-view?from=2030-09-01`);

    const worklist = page.getByRole('listitem').filter({ hasText: guest }).first();
    await worklist.getByRole('button', { name: 'Assign' }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(guest) });
    await expect(dialog.locator('option', { hasText: '202' })).toHaveCount(1);
    await expect(dialog.locator('option', { hasText: '201' })).toHaveCount(0);

    // Another desk moves the rival into 202 after this dialog loaded its list.
    await moveRival('202');

    await selectRoom(dialog, '202');
    await dialog.getByRole('button', { name: 'Assign' }).click();
    await expect(dialog.getByRole('alert')).toContainText('202');
  });

  /**
   * The front desk's day: a guest arrives, gets a key, leaves, and the room
   * goes to housekeeping without anyone typing it in.
   */
  test('checks a guest in, then out, and the room becomes dirty', async ({ page, request }) => {
    const data = testData();
    // Arriving today: the API refuses a check-in for a future arrival.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    const stop = tomorrow.toISOString().slice(0, 10);
    const guest = `Arrival ${Date.now().toString(36)}`;
    const token = await apiToken(request);
    await openForSale(request, token, today, stop);
    await book(request, token, guest, today, stop);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/stay-view?from=${today}`);

    const worklist = page.getByRole('listitem').filter({ hasText: guest });
    await worklist.getByRole('button', { name: 'Assign' }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(guest) });
    await selectRoom(dialog, '202');
    await dialog.getByRole('button', { name: 'Assign' }).click();

    const row = page.getByRole('row', { name: /202/ });
    await expect(row).toContainText(guest);

    // The bar is one tap; what it can do lives in the sheet it opens.
    await row.getByRole('button', { name: new RegExp(guest) }).click();
    const sheet = page.getByRole('dialog', { name: new RegExp(guest) });
    await sheet.getByRole('button', { name: 'Check in' }).click();
    await expect.poll(async () => row.textContent()).toContain('In house');

    await sheet.getByRole('button', { name: 'Check out' }).click();
    await expect.poll(async () => row.textContent()).toContain('Departed');
    await sheet.getByRole('button', { name: 'Close' }).click();

    // The handover that makes check-out worth modelling.
    await page.goto(`/properties/${data.propertyId}/rooms`);
    await expect(page.getByRole('row', { name: /202/ })).toContainText('Dirty');
  });

  /**
   * The morning question: who slept here last night, and have they left? A
   * window that opened on today could not answer it, and a stay that began
   * before the first column used to vanish and shift the whole row.
   */
  test('opens on yesterday and draws a stay that began before the window', async ({
    page,
    request,
  }) => {
    const data = testData();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
    const shift = (days: number) => {
      const value = new Date(`${today}T00:00:00Z`);
      value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10);
    };
    const token = await apiToken(request);
    await openForSale(request, token, shift(-3), shift(3));
    // Arrived two nights ago, leaves tomorrow: in a window opening on
    // yesterday only its tail is visible, which is exactly the stay the old
    // grid dropped.
    const guest = `Overnight ${Date.now().toString(36)}`;
    const made = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: {
        source: 'WALK_IN',
        booker: { name: guest },
        stays: [
          {
            roomTypeId: data.roomTypeId,
            ratePlanId: data.ratePlanId,
            checkIn: shift(-2),
            checkOut: shift(1),
            adults: 1,
          },
        ],
      },
    });
    expect(made.ok(), await made.text()).toBeTruthy();
    const stayId = ((await made.json()) as { stays: { id: string }[] }).stays[0]!.id;
    const rooms = (await (
      await request.get(`${API}/properties/${data.propertyId}/rooms`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { items: { id: string; roomNumber: string }[] };
    const assigned = await request.patch(
      `${API}/properties/${data.propertyId}/stays/${stayId}/room`,
      {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        data: { roomId: rooms.items.find((room) => room.roomNumber === '201')!.id },
      },
    );
    expect(assigned.ok(), await assigned.text()).toBeTruthy();

    await login(page, data.managerEmail);

    // No ?from: the first column is yesterday and today is marked.
    await page.goto(`/properties/${data.propertyId}/stay-view`);
    await expect(page.getByLabel('Go to date')).toHaveValue(shift(-1));
    await expect(page.locator('[role="columnheader"][aria-current="date"]')).toHaveCount(1);

    // The stay began before the window and must still be on the row, cut at
    // the left edge, on the right day.
    const row = page.getByRole('row', { name: /201/ });
    const bar = row.getByRole('button', { name: new RegExp(guest) });
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/rounded-l-none/);
    // Bars are positioned by column: left edge 0 for a cut start, and its
    // width covers last night, tonight, and half of tomorrow's check-out day.
    await expect(bar).toHaveAttribute('style', /left: ?calc\(var\(--col\) \* 0 /);
    await expect(bar).toHaveAttribute('style', /width: ?calc\(var\(--col\) \* 2\.5 /);
  });

  /**
   * Moving a guest: by dragging the bar with a mouse, and from the sheet for
   * anyone without one. The row under each heading counts rooms with nobody
   * in them and must follow the move.
   */
  test('moves a guest by dragging the bar, and again from the sheet', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token, '2030-11-01', '2030-11-06');
    const guest = `Mover ${Date.now().toString(36)}`;
    const { stayId } = await book(request, token, guest, '2030-11-02', '2030-11-04');
    const rooms = (await (
      await request.get(`${API}/properties/${data.propertyId}/rooms`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { items: { id: string; roomNumber: string }[] };
    const placed = await request.patch(
      `${API}/properties/${data.propertyId}/stays/${stayId}/room`,
      {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        data: { roomId: rooms.items.find((room) => room.roomNumber === '201')!.id },
      },
    );
    expect(placed.ok(), await placed.text()).toBeTruthy();

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/stay-view?from=2030-11-01`);

    const from = page.getByRole('row', { name: /^201$/ });
    const to = page.getByRole('row', { name: /^202$/ });
    const bar = from.getByRole('button', { name: new RegExp(guest) });
    await expect(bar).toBeVisible();

    // One room fewer free on the 2nd than on the 1st: this guest's. Other
    // specs add rooms of this type, so the count is relative, not absolute.
    const freeRow = page.getByRole('row', { name: /Deluxe Double Free/ });
    const freeOnFirst = Number(await freeRow.getByRole('cell').nth(0).textContent());
    await expect(freeRow.getByRole('cell').nth(1)).toHaveText(String(freeOnFirst - 1));

    const barBox = (await bar.boundingBox())!;
    const toBox = (await to.boundingBox())!;
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(barBox.x + barBox.width / 2, toBox.y + toBox.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(to.getByRole('button', { name: new RegExp(guest) })).toBeVisible();
    await expect(from.getByRole('button', { name: new RegExp(guest) })).toHaveCount(0);
    await expect(freeRow.getByRole('cell').nth(1)).toHaveText(String(freeOnFirst - 1));

    // And back, without a mouse.
    await to.getByRole('button', { name: new RegExp(guest) }).click();
    const sheet = page.getByRole('dialog', { name: new RegExp(guest) });
    await sheet.getByRole('button', { name: 'Move room' }).click();
    const picker = sheet.getByRole('combobox');
    await expect(picker.locator('option', { hasText: '201' })).toHaveCount(1);
    await expect(picker.locator('option', { hasText: '202' })).toHaveCount(0);
    await picker.selectOption(
      (await picker.locator('option', { hasText: '201' }).getAttribute('value')) ?? '',
    );
    await sheet.getByRole('button', { name: 'Move', exact: true }).click();

    await expect(from.getByRole('button', { name: new RegExp(guest) })).toBeVisible();
    await expect(sheet).toHaveCount(0);
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
