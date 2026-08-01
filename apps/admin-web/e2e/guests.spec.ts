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

async function book(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  booker: { name: string; email?: string; phone?: string },
  checkIn: string,
  checkOut: string,
): Promise<void> {
  const data = testData();
  const response = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data: {
      source: 'WALK_IN',
      booker,
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

/**
 * Its own dates, well outside the fixture window.
 *
 * Booking on the shared dates consumes allotment the inventory spec asserts
 * on — 0/5 quietly becomes 2/5 — and the failure lands in a file this one
 * never touches.
 */
const NIGHTS = ['2031-06-01', '2031-06-02', '2031-06-03', '2031-06-04'];

async function openForSale(
  request: import('@playwright/test').APIRequestContext,
  token: string,
): Promise<void> {
  const data = testData();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  await request.patch(`${API}/properties/${data.propertyId}/inventory`, {
    headers,
    data: {
      updates: [{ roomTypeId: data.roomTypeId, from: NIGHTS[0]!, to: '2031-06-05', allotment: 10 }],
    },
  });
  await request.patch(`${API}/properties/${data.propertyId}/rates`, {
    headers,
    data: {
      updates: [
        {
          ratePlanId: data.ratePlanId,
          from: NIGHTS[0]!,
          to: '2031-06-05',
          prices: [
            { occupancy: 1, amount: 150000 },
            { occupancy: 2, amount: 250000 },
          ],
        },
      ],
    },
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('guests', () => {
  test('builds a profile from a booking and counts a return visit', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token);
    const surname = `Rian${Date.now().toString(36)}`;
    const email = `${surname.toLowerCase()}@example.com`;

    await book(request, token, { name: `Somchai ${surname}`, email }, NIGHTS[0]!, NIGHTS[1]!);
    await book(request, token, { name: `Somchai ${surname}`, email }, NIGHTS[2]!, NIGHTS[3]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/guests?q=${surname}`);

    const row = page.getByRole('row', { name: new RegExp(surname) });
    await expect(row).toHaveCount(1);
    // Two bookings, one profile — the point of the module.
    await expect(row).toContainText('2');
  });

  /**
   * A shared address is real: a company books its staff through one inbox.
   * Matching on email alone would show one person another's stays, so these
   * stay separate and are flagged for a human instead.
   */
  test('keeps two people who share an email apart, and says so', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token);
    const shared = `office${Date.now().toString(36)}@example.com`;

    // DIFFERENT family names on purpose. Two colleagues booking through one
    // office inbox are two people. The same surname with the same address is
    // the same person, which is precisely what the matching rule decides — an
    // earlier version of this test used "Company" for both and was asserting
    // that the rule fails.
    await book(request, token, { name: 'Anan Sirikul', email: shared }, NIGHTS[0]!, NIGHTS[1]!);
    await book(request, token, { name: 'Benja Wattana', email: shared }, NIGHTS[2]!, NIGHTS[3]!);

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/guests?q=${shared}`);

    await expect(page.getByRole('row', { name: /Anan Sirikul/ })).toHaveCount(1);
    await expect(page.getByRole('row', { name: /Benja Wattana/ })).toHaveCount(1);
    await expect(page.getByText(/Might be the same person as/).first()).toBeVisible();
  });

  /**
   * The fix for the problem the flag describes.
   *
   * The panel opens on the row that will be KEPT, because the direction decides
   * whose spelling, email and notes lead — and nothing in the resulting data
   * says which way round it went.
   */
  test('folds a mistyped duplicate into the profile the hotel keeps', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token);

    const surname = `Chaiyo${Date.now().toString(36)}`;
    const phone = '081 234 5678';

    // Same person, same handset, one letter wrong in the address the second
    // time. Exactly the case that made a returning guest look like a new one.
    await book(
      request,
      token,
      { name: `Nid ${surname}`, email: `nid@example.com`, phone },
      NIGHTS[0]!,
      NIGHTS[1]!,
    );
    await book(
      request,
      token,
      { name: `Nid ${surname}`, email: `ndi@example.com`, phone: '+66 81 234 5678' },
      NIGHTS[2]!,
      NIGHTS[3]!,
    );

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/guests?q=${surname}`);
    await expect(page.getByRole('row', { name: new RegExp(surname) })).toHaveCount(2);

    // Keep the first profile — the one with the correct address.
    const survivor = page.getByRole('row', { name: /nid@example\.com/ });
    await survivor.getByRole('button', { name: /Might be the same person as/ }).click();

    // The phone matched across two spellings of one number.
    await expect(page.getByText('Very likely').first()).toBeVisible();
    await expect(page.getByText(/same phone/).first()).toBeVisible();

    await page.getByRole('button', { name: 'Fold into this profile' }).first().click();
    // Named in full before it happens: this cannot be undone.
    await expect(page.getByText(/This cannot be undone/)).toBeVisible();
    await page.getByRole('button', { name: 'Merge', exact: true }).click();

    await expect(page.getByRole('status')).toContainText('1 booking');

    await page.goto(`/properties/${data.propertyId}/guests?q=${surname}`);
    const remaining = page.getByRole('row', { name: new RegExp(surname) });
    await expect(remaining).toHaveCount(1);
    // Both stays now sit on one profile, which is the whole point.
    await expect(remaining).toContainText('2');
    await expect(remaining).toContainText('nid@example.com');
  });

  test('offers no merge control to someone who cannot edit guests', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    await openForSale(request, token);
    const shared = `desk${Date.now().toString(36)}@example.com`;

    await book(request, token, { name: 'Anan Sirikul', email: shared }, NIGHTS[0]!, NIGHTS[1]!);
    await book(request, token, { name: 'Benja Wattana', email: shared }, NIGHTS[2]!, NIGHTS[3]!);

    // A genuinely read-only user: front desk HOLDS guest:update, so it would
    // prove nothing here.
    await login(page, data.readOnlyEmail);
    await page.goto(`/properties/${data.propertyId}/guests?q=${shared}`);

    // The flag still shows: knowing the guest book has duplicates in it is
    // useful even to someone who cannot fix them.
    await expect(page.getByText(/Might be the same person as/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Might be the same person as/ })).toHaveCount(0);
  });

  test('says nobody matches rather than showing an empty table', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/guests?q=nobody-by-that-name`);

    await expect(page.getByText('Nobody matches that search.')).toBeVisible();
  });
});
