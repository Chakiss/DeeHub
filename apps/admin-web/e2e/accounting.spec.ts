import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

const API = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

async function ownerToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const data = testData();
  const response = await request.post(`${API}/auth/login`, {
    data: {
      organizationSlug: data.organizationSlug,
      email: data.ownerEmail,
      password: 'dashboard-e2e-password',
    },
  });
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/**
 * The books, through the browser.
 *
 * The arithmetic is covered by the API's unit and e2e tests. What these add is
 * the thing only a browser can show: that the VAT split appears as the owner
 * types, that the withholding line turns a percentage into two amounts, and
 * that a manager and an owner genuinely see different pages at the same URL.
 */

test.describe.configure({ mode: 'serial' });

function accountingUrl(propertyId: string): string {
  return `/properties/${propertyId}/accounting`;
}

test.describe('accounting', () => {
  test('splits VAT out of the total as the owner types it', async ({ page, request }) => {
    const data = testData();

    // The VAT toggle only appears for a registered property, and the split is
    // the thing worth testing — so register it rather than skipping past.
    const token = await ownerToken(request);
    await request.put(`${API}/properties/${data.propertyId}/accounting/settings`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { vatRegistered: true, vatRegisteredFrom: '2020-01-01' },
    });

    await login(page, data.ownerEmail);
    await page.goto(accountingUrl(data.propertyId));

    await expect(page.getByRole('heading', { name: 'Accounting' })).toBeVisible();

    // The worksheet notice is load-bearing, not decoration: it is what keeps
    // these figures from being mistaken for a filing.
    await expect(page.getByText(/not a filing/i)).toBeVisible();

    await page.getByLabel('Amount on the receipt').fill('1070');
    await page.getByLabel('Includes 7% VAT').check();

    // 1,070 inclusive of 7% is 1,000 plus 70 — worked out as the owner types,
    // so nobody divides by 1.07 on a phone.
    await expect(page.getByText(/1,000\.00/)).toBeVisible();
    await expect(page.getByText(/\b70\.00/)).toBeVisible();
  });

  test('records an expense and shows it in the list', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(accountingUrl(data.propertyId));

    const description = `Electricity ${Date.now()}`;
    await page.getByLabel('Amount on the receipt').fill('2500');
    await page.getByLabel('What was it for').fill(description);
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('cell', { name: description })).toBeVisible();
  });

  test('tells the owner what to pay the supplier and what to remit', async ({ page, request }) => {
    const data = testData();

    // Set the VAT state this test depends on rather than inheriting it from
    // whichever test ran before.
    const token = await ownerToken(request);
    await request.put(`${API}/properties/${data.propertyId}/accounting/settings`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      data: { vatRegistered: true, vatRegisteredFrom: '2020-01-01' },
    });

    await login(page, data.ownerEmail);
    await page.goto(accountingUrl(data.propertyId));

    // Rent carries a 5% default, and the bill is over the 1,000 baht threshold
    // below which nothing need be withheld.
    await page.getByLabel('Amount on the receipt').fill('10000');
    await page.getByLabel('Includes 7% VAT').check();
    await page.getByLabel('Category').selectOption({ label: 'Land and building rent' });

    // One line that answers both questions: what leaves for the supplier, and
    // what leaves for the Revenue Department.
    const hint = page.getByText(/Pay the supplier .*, remit .* to the Revenue Department/i);
    await expect(hint).toBeVisible();

    /*
     * The numbers matter more than the sentence. A 10,000 bill inclusive of 7%
     * is 9,345.79 of service, and withholding is 5% of THAT — 467.29, not 500.
     * Taking 5% off the VAT-inclusive total would over-withhold, short-pay the
     * landlord, and put a wrong figure on the certificate they use to claim the
     * credit back. This asserts the browser agrees with the server about it.
     */
    await expect(hint).toContainText('467.29');
    await expect(hint).toContainText('9,532.71');
  });

  test('shows a manager the entry form but not the profit', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(accountingUrl(data.propertyId));

    // A manager buys the property's electricity, so the form is theirs.
    await expect(page.getByLabel('Amount on the receipt')).toBeVisible();

    // What the owner clears after those costs is not.
    await expect(page.getByText('Net profit')).toHaveCount(0);
    await expect(page.getByText('Profit and loss')).toHaveCount(0);
    await expect(page.getByText(/not a filing/i)).toHaveCount(0);
  });

  test('shows the owner the month and its totals', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.goto(accountingUrl(data.propertyId));

    await expect(page.getByText('Net profit').first()).toBeVisible();
    await expect(page.getByText('Profit and loss')).toBeVisible();
    // VAT is reported next to the result, never inside it.
    await expect(page.getByText('Output VAT (on sales)')).toBeVisible();
  });

  test('is reachable from the navigation', async ({ page }) => {
    const data = testData();
    await login(page, data.ownerEmail);
    await page.getByRole('link', { name: 'Accounting' }).first().click();
    await page.waitForURL(/\/accounting$/);
    await expect(page.getByRole('heading', { name: 'Accounting' })).toBeVisible();
  });

  test('works at phone width', async ({ page }) => {
    const data = testData();
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, data.ownerEmail);
    await page.goto(accountingUrl(data.propertyId));

    const description = `Water ${Date.now()}`;
    await page.getByLabel('Amount on the receipt').fill('480');
    await page.getByLabel('What was it for').fill(description);
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('cell', { name: description })).toBeVisible();

    /*
     * The 720px expense table must scroll inside its own container rather than
     * widening the page — without `min-w-0` on the grid children it does the
     * latter, and the save button ends up off-screen.
     *
     * Asserted as "no worse than a page without a wide table" rather than as
     * zero, because the navy header already overflows by ~108px at this width
     * on EVERY screen in the dashboard. That is a real pre-existing bug and a
     * separate change; pinning zero here would fail for a reason that has
     * nothing to do with the books.
     */
    const overflowOf = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );

    const onAccounting = await overflowOf();
    await page.goto(`/properties/${data.propertyId}/reports`);
    const onReports = await overflowOf();

    expect(onAccounting).toBeLessThanOrEqual(onReports);
  });
});
