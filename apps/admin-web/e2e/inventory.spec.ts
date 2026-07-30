import { expect, test, type Page } from '@playwright/test';
import { login, testData } from './helpers';

/** The grid cell for a room type on a date, located by its column position. */
async function cellText(page: Page, roomTypeName: string, date: string): Promise<string> {
  const headers = page.locator('thead th');
  const count = await headers.count();

  let column = -1;
  for (let index = 1; index < count; index += 1) {
    const label = await headers.nth(index).textContent();
    // Header shows "Mon 1 Apr"; match on the day number and month.
    const day = String(Number(date.slice(8, 10)));
    const month = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      timeZone: 'UTC',
    });
    if (label?.includes(day) && label.includes(month)) {
      column = index;
      break;
    }
  }
  expect(column, `column for ${date} should exist`).toBeGreaterThan(0);

  const row = page.locator('tbody tr').filter({ hasText: roomTypeName });
  return (
    (await row
      .locator('td')
      .nth(column - 1)
      .textContent()) ?? ''
  );
}

test.describe('inventory grid', () => {
  test.beforeEach(async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    // Anchor the window so cells are deterministic regardless of today's date.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[0]}`);
  });

  test('shows availability over allotment for every room type', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();

    const deluxe = await cellText(page, 'Deluxe Double', testData().dates[0]!);
    // "5" available, "0/5" booked over allotment.
    expect(deluxe).toContain('5');
    expect(deluxe).toContain('0/5');
  });

  test('shows the price in the same cell as the availability', async ({ page }) => {
    const deluxe = await cellText(page, 'Deluxe Double', testData().dates[0]!);
    // 250000 minor units in THB, compact and without a repeated symbol.
    expect(deluxe).toContain('2,500');
  });

  test('reports occupancy for the room types on screen', async ({ page }) => {
    const footer = page.locator('tfoot tr');
    await expect(footer).toContainText('Occupancy');
    // Nothing booked in the fixture, and allotment is offered, so 0% is a real
    // answer rather than an absent one.
    await expect(footer).toContainText('0%');
  });

  test('names the currency once instead of in every cell', async ({ page }) => {
    await expect(page.getByText('Prices in THB')).toBeVisible();
  });

  test('marks a room type with no inventory rows as not open for sale', async ({ page }) => {
    // The Standard Twin is deliberately seeded with no inventory. Rendering it
    // blank would let a hotel believe it is selling dates it never opened.
    const standard = await cellText(page, 'Standard Twin', testData().dates[0]!);
    expect(standard.trim()).toBe('—');
  });

  test('paging moves the window without losing the property', async ({ page }) => {
    const data = testData();
    await page.getByRole('link', { name: /Next/ }).click();
    await expect(page).toHaveURL(/[?&]from=/);
    await expect(page).toHaveURL(new RegExp(data.propertyId));
    await expect(page.getByRole('heading', { name: 'Inventory' })).toBeVisible();
  });

  test('bulk edit applies to the chosen weekdays only', async ({ page }) => {
    const data = testData();
    // 2030-04-01 is a Monday, so 04-05 is Friday and 04-06 is Saturday.
    await page.getByRole('button', { name: 'Bulk edit' }).click();

    await page.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill('2030-04-07');
    await page.getByRole('button', { name: 'FRI', exact: true }).click();
    await page.getByRole('button', { name: 'SAT', exact: true }).click();
    await page.getByLabel('Allotment').fill('2');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByRole('dialog')).toBeHidden();

    // Friday and Saturday changed…
    await expect.poll(async () => cellText(page, 'Deluxe Double', '2030-04-05')).toContain('0/2');
    expect(await cellText(page, 'Deluxe Double', '2030-04-06')).toContain('0/2');
    // …and the weekdays did not.
    expect(await cellText(page, 'Deluxe Double', '2030-04-01')).toContain('0/5');
    expect(await cellText(page, 'Deluxe Double', '2030-04-02')).toContain('0/5');
  });

  /**
   * The state worth catching: rooms opened for sale with no price behind them.
   * The Standard Twin has no rate plan in the fixture, so giving it allotment
   * produces a night that looks bookable on every other screen and fails with
   * RATE_MISSING the moment a guest tries.
   */
  test('flags nights opened for sale with no price', async ({ page }) => {
    const data = testData();
    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });
    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[1]!);
    await page.getByLabel('Allotment').fill('3');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByRole('dialog')).toBeHidden();

    // Sellable-looking on availability alone, and explicitly not priced.
    await expect.poll(async () => cellText(page, 'Standard Twin', data.dates[0]!)).toContain('0/3');
    expect(await cellText(page, 'Standard Twin', data.dates[0]!)).toContain('no rate');
  });

  test('setting a restriction leaves allotment untouched', async ({ page }) => {
    const data = testData();
    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
    await page.getByLabel('From').fill(data.dates[2]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[3]!);
    await page.getByLabel('Minimum stay').fill('3');
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByRole('dialog')).toBeHidden();
    // Allotment survives a min-stay edit; wiping it would empty the calendar.
    await expect.poll(async () => cellText(page, 'Deluxe Double', data.dates[2]!)).toContain('0/5');
  });

  test('refuses an edit that changes nothing, before calling the API', async ({ page }) => {
    const data = testData();
    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[1]!);
    await page.getByRole('button', { name: 'Apply' }).click();

    await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
    // Still open, so the user can correct it rather than losing their input.
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('front desk cannot edit inventory', async ({ page }) => {
    const data = testData();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, data.frontDeskEmail);
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[0]}`);

    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[1]!);
    await page.getByLabel('Allotment').fill('1');
    await page.getByRole('button', { name: 'Apply' }).click();

    // The server rejects it; the UI surfaces that rather than pretending it
    // worked or crashing.
    const alert = page.getByRole('dialog').getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/capability|permission/i);
  });
});
