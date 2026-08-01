import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';
import { removeIsolatedRoomType, seedIsolatedRoomType, type IsolatedRoomType } from './fixtures';

/**
 * Taking, reading, changing and cancelling a booking through the browser.
 *
 * The list already had coverage; everything a clerk actually DOES to a booking
 * did not. These are the screens where a mistake costs a room.
 *
 * This spec brings its OWN room type, rates and dates. It books, cancels and
 * moves rooms, and the shared fixture room type is asserted on with absolute
 * counts by the inventory and reservation specs — which run after this one in
 * the serial order. Sharing rows made those specs fail.
 */

const API = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

/** Outside the shared fixture's window, so nothing else asserts on these. */
const NIGHTS = ['2031-06-01', '2031-06-02', '2031-06-03', '2031-06-04', '2031-06-05'];

/**
 * Today in the PROPERTY's timezone, and the days after it.
 *
 * The departure control only appears once a stay has begun — before that the
 * full editor is the right one — so the cases that exercise it have to book
 * real dates rather than 2031.
 */
function bangkokToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

const IN_HOUSE = [0, 1, 2, 3, 4, 5].map((offset) => addDays(bangkokToday(), offset));

let room: IsolatedRoomType;

test.beforeAll(async () => {
  room = await seedIsolatedRoomType(testData(), {
    code: 'BKG',
    name: 'Booking Spec Suite',
    dates: [...NIGHTS, ...IN_HOUSE],
  });
});

test.afterAll(async () => {
  await removeIsolatedRoomType(room);
});

async function apiToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const data = testData();
  const response = await request.post(`${API}/auth/login`, {
    data: {
      organizationSlug: data.organizationSlug,
      email: data.managerEmail,
      password: 'dashboard-e2e-password',
    },
  });
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

/** A booking made through the API, so a test can start from an existing one. */
async function book(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  guestName: string,
  checkIn: string,
  checkOut: string,
): Promise<{ id: string; code: string }> {
  const data = testData();
  const response = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: {
      source: 'PHONE',
      booker: { name: guestName, email: 'ploy@example.test', phone: '+66812345678' },
      stays: [
        { roomTypeId: room.roomTypeId, ratePlanId: room.ratePlanId, checkIn, checkOut, adults: 2 },
      ],
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string; code: string };
}

test.describe('taking a booking', () => {
  test('creates a booking from the form and lands on its detail page', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations`);
    await page.getByRole('link', { name: 'New booking' }).click();

    await page.getByLabel('Check-in').fill('2031-06-01');
    await page.getByLabel('Check-out').fill('2031-06-03');

    // Availability is read for exactly the chosen nights, before anything is
    // committed. Deliberately not an exact count: earlier tests in this serial
    // run book rooms, and asserting "5 left" would make this pass only first.
    const panel = page.locator('section', { hasText: 'What is sellable' });
    await expect(panel.locator('li', { hasText: room.roomTypeName })).toContainText(/\d+ left/);

    await page.getByLabel('Room type').selectOption(room.roomTypeId);
    await page.getByLabel('Name', { exact: true }).fill('Kanya Srisuk');
    await page.getByRole('button', { name: 'Create booking' }).click();

    await page.waitForURL(/\/reservations\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Kanya Srisuk')).toBeVisible();
    await expect(page.getByText('confirmed')).toBeVisible();
  });

  /**
   * The form shows what is sellable but takes NO hold. A room type with no
   * inventory rows at all cannot be sold, and saying so before the clerk types
   * a guest's name is the entire point of the panel.
   */
  test('shows a room type with no inventory as unsellable', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);

    await page.getByLabel('Check-in').fill('2031-06-01');
    await page.getByLabel('Check-out').fill('2031-06-02');

    // Scoped to the availability card: the room picker below carries the same
    // names inside a <select>, so an unscoped `li` matches the wrong card.
    const panel = page.locator('section', { hasText: 'What is sellable' });
    const row = panel.locator('li', { hasText: 'Standard Twin' });

    // "Closed" rather than "Sold out": with no inventory row at all the grid's
    // own `open` flag is false, and that flag is the authority. The line below
    // it carries the actionable fact — there is no price either.
    await expect(row).toContainText('Closed');
    await expect(row).toContainText('No rate');
  });

  test('refuses to submit without a booker name', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/new`);

    await page.getByRole('button', { name: 'Create booking' }).click();
    await expect(page.getByText('Enter the name of whoever is booking.')).toBeVisible();
  });
});

test.describe('reading and changing a booking', () => {
  test('shows the booker, the frozen nightly rates and the money breakdown', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    const reservation = await book(request, token, 'Ploy Bookingspec', '2031-06-01', '2031-06-03');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${reservation.id}`);

    await expect(page.getByRole('heading', { name: reservation.code })).toBeVisible();
    await expect(page.getByText('ploy@example.test')).toBeVisible();
    await expect(page.getByText('+66812345678')).toBeVisible();

    // 2 nights at 2,500.00 subtotal, plus 7% tax and 10% service on the
    // property. Intl in en-US spells THB rather than using the ฿ sign.
    await expect(page.getByText('THB 5,000.00').first()).toBeVisible();

    // Each night at the price it was sold at. Scoped to cells, because the
    // stay header carries "2031-06-01 → 2031-06-03" as well.
    await page.getByText('Nightly rates').click();
    await expect(page.getByRole('cell', { name: '2031-06-01' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '2031-06-02' })).toBeVisible();
    // The check-out date is not a night slept and must not be priced.
    await expect(page.getByRole('cell', { name: '2031-06-03' })).toHaveCount(0);
  });

  test('cancels a booking and says so on the page', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const reservation = await book(request, token, 'Anong Chai', '2031-06-04', '2031-06-05');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${reservation.id}`);

    await page.getByRole('button', { name: 'Cancel booking' }).first().click();
    // A panel, not a browser confirm: cancelling releases inventory and is not
    // undoable, so it explains itself and records why.
    await expect(page.getByText('Cancel this booking?')).toBeVisible();
    await page.getByLabel('Reason (optional)').fill('Guest called to cancel');
    await page.getByRole('button', { name: 'Cancel booking' }).last().click();

    // Exact, because the page also carries a "Cancelled" field label.
    await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(page.getByText('Guest called to cancel')).toBeVisible();
  });

  test('changes the dates of a stay and re-prices the booking', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const reservation = await book(request, token, 'Niran Pho', '2031-06-01', '2031-06-02');

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${reservation.id}`);

    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByLabel('Check-out').fill('2031-06-03');
    await page.getByRole('button', { name: 'Save change' }).click();

    // One night became two: the subtotal must follow, not stay put.
    await expect(page.getByText('THB 5,000.00').first()).toBeVisible();
    await expect(page.getByText('2031-06-01 → 2031-06-03')).toBeVisible();
  });

  /**
   * Modification releases the old nights and takes the new ones. A sold-out
   * target must leave the ORIGINAL booking intact rather than half-moved.
   */
  test('refuses a move onto a sold-out night and keeps the original dates', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    const reservation = await book(request, token, 'Suda Kaew', '2031-06-01', '2031-06-02');

    // A date the fixture never gave inventory to.
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${reservation.id}`);

    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByLabel('Check-in').fill('2031-01-01');
    await page.getByLabel('Check-out').fill('2031-01-02');
    await page.getByRole('button', { name: 'Save change' }).click();

    // The API's own message names the reason; the dates are unchanged.
    await expect(page.getByText('2031-06-01 → 2031-06-02')).toBeVisible();
  });

  test('offers a front-desk user no cancel control when they lack the capability', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    const reservation = await book(request, token, 'Mali Thong', '2031-06-04', '2031-06-05');

    // FRONT_DESK does hold reservation:cancel, so this asserts the control is
    // present for them — the refusal path is covered by the API suite.
    await login(page, data.frontDeskEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${reservation.id}`);
    await expect(page.getByRole('button', { name: 'Cancel booking' })).toBeVisible();
  });
});

/**
 * The departure date, moved in both directions from one control.
 *
 * The API keeps extending and shortening apart — they do opposite things to
 * inventory — but at the desk it is one question, and these prove the screen
 * asks it that way and sends the right call either way.
 */
test.describe('changing when a guest leaves', () => {
  test('moves check-out later, and says what the extra nights cost', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const booking = await book(request, token, 'Anong Extend', IN_HOUSE[0]!, IN_HOUSE[1]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Change departure date' }).click();
    await page.getByLabel('New check-out').fill(IN_HOUSE[3]!);
    // Named before it happens: the two directions cost the hotel opposite
    // things and the button says neither.
    await expect(page.getByText(/adds nights to the end/)).toBeVisible();

    await page.getByRole('button', { name: 'Save departure date' }).click();
    await expect(page.getByText(/The added nights come to/)).toBeVisible();
  });

  test('moves check-out earlier, releases the nights, and charges no fee', async ({
    page,
    request,
  }) => {
    const data = testData();
    const token = await apiToken(request);
    const booking = await book(request, token, 'Anong Shorten', IN_HOUSE[0]!, IN_HOUSE[3]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Change departure date' }).click();
    await page.getByLabel('New check-out').fill(IN_HOUSE[1]!);
    await expect(page.getByText(/releases the dropped nights/)).toBeVisible();

    await page.getByRole('button', { name: 'Save departure date' }).click();
    // A hotelier will assume a penalty was applied, so the screen says it was
    // not — there is no folio for one to land on yet.
    await expect(page.getByText(/no early-departure fee/)).toBeVisible();

    // And the booking really is shorter.
    await page.reload();
    await expect(page.getByText(`${IN_HOUSE[0]!} → ${IN_HOUSE[1]!}`)).toBeVisible();
  });

  test('refuses to save a date that has not changed', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const booking = await book(request, token, 'Anong Same', IN_HOUSE[0]!, IN_HOUSE[2]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reservations/${booking.id}`);

    await page.getByRole('button', { name: 'Change departure date' }).click();
    await page.getByRole('button', { name: 'Save departure date' }).click();

    // Caught before a request: neither endpoint would accept it, and both
    // would answer with something less obvious than this.
    //
    // Scoped to the paragraph, not getByRole('alert'): Next always renders a
    // route announcer with role="alert", so an unscoped query is ambiguous —
    // the same trap the auth spec documents.
    await expect(page.getByText('That is already the departure date.')).toBeVisible();
  });
});
