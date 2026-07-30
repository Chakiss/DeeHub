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

/** Yesterday in the property's timezone — the report looks backwards. */
function recentNight(): { night: string; nextDay: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const base = new Date(`${today}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - 1);
  const night = base.toISOString().slice(0, 10);
  base.setUTCDate(base.getUTCDate() + 1);
  return { night, nextDay: base.toISOString().slice(0, 10) };
}

test.describe.configure({ mode: 'serial' });

test.describe('performance report', () => {
  test('shows rooms sold, revenue and ADR for a night that was sold', async ({ page, request }) => {
    const data = testData();
    const token = await apiToken(request);
    const { night, nextDay } = recentNight();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    // The fixture only opens 2030 dates, so open and price a recent night.
    await request.patch(`${API}/properties/${data.propertyId}/inventory`, {
      headers,
      data: { updates: [{ roomTypeId: data.roomTypeId, from: night, to: nextDay, allotment: 4 }] },
    });
    await request.patch(`${API}/properties/${data.propertyId}/rates`, {
      headers,
      data: {
        updates: [
          {
            ratePlanId: data.ratePlanId,
            from: night,
            to: nextDay,
            prices: [
              { occupancy: 1, amount: 100000 },
              { occupancy: 2, amount: 150000 },
            ],
          },
        ],
      },
    });
    const booking = await request.post(`${API}/properties/${data.propertyId}/reservations`, {
      headers,
      data: {
        source: 'WALK_IN',
        booker: { name: 'Report Guest' },
        stays: [
          {
            roomTypeId: data.roomTypeId,
            ratePlanId: data.ratePlanId,
            checkIn: night,
            checkOut: nextDay,
            adults: 2,
          },
        ],
      },
    });
    expect(booking.ok(), await booking.text()).toBeTruthy();

    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reports`);

    await expect(page.getByRole('heading', { name: 'Performance' })).toBeVisible();
    // One room at 1,500.00 — ADR equals the rate when a single room sold.
    await expect(page.getByText('1,500.00').first()).toBeVisible();
  });

  /**
   * The decision the report rests on. Occupancy is measured against physical
   * rooms, which the fixture has none of, so it must say why rather than
   * quietly showing 0% — a wrong number costs trust in every other one.
   */
  test('explains why occupancy is blank instead of showing zero', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reports`);

    await expect(page.getByText('Occupancy and RevPAR need physical rooms')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add rooms' })).toBeVisible();

    // Sell-through is measured against allotment, so it is always answerable.
    // The label appears as a tile, a hint and a column header, so this asserts
    // the tile actually carries a percentage rather than a dash.
    const tile = page
      .locator('div')
      .filter({ hasText: /^Sell-through/ })
      .first();
    await expect(tile).toContainText('%');
  });

  test('switches between the last 7 and 30 days', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/reports`);

    await page.getByRole('link', { name: 'Last 7 days' }).click();
    await expect(page).toHaveURL(/days=7/);
    // 7 nights plus a header row.
    await expect(page.locator('tbody tr')).toHaveCount(7);
  });
});
