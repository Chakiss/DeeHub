import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Rate plans and pricing, end to end.
 *
 * The last test is the one that matters: it walks the whole setup path a new
 * property goes through — a room type with allotment but no price, which the
 * grid flags as unsellable, then a rate plan and prices, after which the same
 * night shows a price. Nothing else proves the pieces connect.
 */
test.describe.configure({ mode: 'serial' });

test.describe('rate plans', () => {
  test('creates a rate plan against a room type', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();

    await page.getByLabel('Room type').selectOption({ label: 'Deluxe Double' });
    await page.getByLabel('Code').fill('e2e-nrf');
    await page.getByLabel('Name', { exact: true }).fill('Non-refundable');
    await page.getByLabel('Meal plan').selectOption('BREAKFAST');
    await page.getByLabel('Refundable').uncheck();
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.getByRole('row', { name: /Non-refundable/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText('E2E-NRF');
    await expect(row).toContainText('Breakfast');
  });

  test('refuses a duplicate code', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    await page.getByLabel('Code').fill('E2E-NRF');
    await page.getByLabel('Name', { exact: true }).fill('Duplicate');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page.locator('form').getByRole('alert')).toContainText(/already used/i);
  });

  test('locks the code and the room type once the plan exists', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page
      .getByRole('row', { name: /Non-refundable/ })
      .getByRole('button', { name: 'Edit' })
      .click();

    // The code anchors OTA rate mappings; the room type is what every priced
    // night was sold under.
    await expect(page.getByLabel('Code')).toBeDisabled();
    await expect(page.getByLabel('Room type')).toBeDisabled();
  });

  test('offers no parent to derive from when the room type has none', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    // The Standard Twin has no rate plan of its own, so there is nothing on
    // that room type to base a price on. Showing the toggle anyway would open
    // a form whose only dropdown is empty.
    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });

    await expect(page.getByLabel('Price this from another plan')).toHaveCount(0);
  });

  test('a read-only user gets no editing controls', async ({ page }) => {
    const data = testData();
    await login(page, data.frontDeskEmail);

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await expect(page.getByRole('row', { name: /Non-refundable/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add rate plan' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set prices' })).toHaveCount(0);
  });

  test('pricing a plan turns an unsellable night into a sellable one', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    // 1. Give the Standard Twin allotment. It has no rate plan in the fixture,
    //    so these nights are open for sale with nothing to sell them at.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[0]}`);
    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });
    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[2]!);
    await page.getByLabel('Allotment').fill('4');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    const standardRow = page.locator('tbody tr').filter({ hasText: 'Standard Twin' });
    await expect.poll(async () => standardRow.textContent()).toContain('no rate');

    // 2. Create a plan for it and price the same nights.
    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });
    await page.getByLabel('Code').fill('e2e-std');
    await page.getByLabel('Name', { exact: true }).fill('Standard Rate');
    await page.getByRole('button', { name: 'Save' }).click();

    const planRow = page.getByRole('row', { name: /Standard Rate/ });
    await expect(planRow).toBeVisible();
    await planRow.getByRole('button', { name: 'Set prices' }).click();

    await page.getByLabel('From').fill(data.dates[0]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[2]!);
    // Priced per occupancy: a booking is quoted by how many guests it is for.
    await page.getByLabel('1 guest').fill('900');
    await page.getByLabel('2 guests').fill('1200');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // 3. The same night now carries a price and no longer warns.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[0]}`);
    const priced = page.locator('tbody tr').filter({ hasText: 'Standard Twin' });
    // Standard occupancy is 2 for this room type, so 1,200 is the lead price.
    await expect.poll(async () => priced.textContent()).toContain('1,200');
    expect(await priced.textContent()).not.toContain('no rate');
  });

  /**
   * The counterpart. Before this existed a mis-typed price could only be
   * overwritten, and the obvious workaround — typing 0 — leaves the room
   * sellable for nothing rather than taking the night off sale.
   *
   * Uses the LAST three fixture dates, so it does not collide with the pricing
   * test above, which uses the first three.
   */
  test('removing a price puts the night back to unsellable, not free', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    // Allotment first, so the night is genuinely on sale and losing its price
    // is a real change rather than a no-op.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[3]}`);
    await page.getByRole('button', { name: 'Bulk edit' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });
    await page.getByLabel('From').fill(data.dates[3]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[5]!);
    await page.getByLabel('Allotment').fill('4');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    await page.getByLabel('Room type').selectOption({ label: 'Standard Twin' });
    await page.getByLabel('Code').fill('e2e-clr');
    await page.getByLabel('Name', { exact: true }).fill('Clearable Rate');
    await page.getByRole('button', { name: 'Save' }).click();

    const planRow = page.getByRole('row', { name: /Clearable Rate/ });
    await expect(planRow).toBeVisible();

    await planRow.getByRole('button', { name: 'Set prices' }).click();
    await page.getByLabel('From').fill(data.dates[3]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[5]!);
    await page.getByLabel('2 guests').fill('1500');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[3]}`);
    const row = page.locator('tbody tr').filter({ hasText: 'Standard Twin' });
    await expect.poll(async () => row.textContent()).toContain('1,500');

    // Now remove them.
    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page
      .getByRole('row', { name: /Clearable Rate/ })
      .getByRole('button', {
        name: 'Remove prices',
      })
      .click();
    // Scoped to the dialog: every rate plan on the page has its own "Remove
    // prices" button, so the bare name matches one per row plus this submit.
    const dialog = page.getByRole('dialog', { name: /Remove prices for/ });
    await dialog.getByLabel('From').fill(data.dates[3]!);
    await dialog.getByLabel('To (exclusive)').fill(data.dates[5]!);
    await dialog.getByRole('button', { name: 'Remove prices' }).click();

    // The dialog stays open and says how much of the hotel just went off sale.
    await expect(dialog.getByText('Removed 2 prices.')).toBeVisible();
    await expect(dialog.getByText(/2 nights can no longer be sold/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Back to unsellable — NOT priced at zero.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[3]}`);
    const cleared = page.locator('tbody tr').filter({ hasText: 'Standard Twin' });
    await expect.poll(async () => cleared.textContent()).toContain('no rate');
    expect(await cleared.textContent()).not.toContain('1,500');
  });

  /**
   * A plan priced as an offset from another one.
   *
   * The point of the feature is that one edit reprices the whole horizon, so
   * the thing worth proving on screen is that a derived plan is created without
   * prices and is not offered the buttons that would set them.
   */
  test('creates a plan priced from another, and offers it no prices of its own', async ({
    page,
  }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/rate-plans`);

    const suffix = Date.now().toString(36).slice(-5);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    await page.getByLabel('Code').fill(`NRF${suffix}`);
    await page.getByLabel('Name').fill(`Derived ${suffix}`);
    await page.getByLabel('Price this from another plan').check();
    // The dropdown defaults to the only eligible parent; the form must SEND
    // that default rather than the state behind it, which stays empty until
    // somebody changes the selection.
    await expect(page.getByLabel('Based on')).toBeVisible();
    await page.getByLabel('By').fill('-10');
    await page.getByRole('button', { name: 'Save' }).click();

    // Scoped by the generated code: an earlier case in this file creates its
    // own plan called "Non-refundable", and a name match resolves to both.
    const row = page.getByRole('row', { name: new RegExp(`NRF${suffix}`, 'i') });
    await expect(row).toBeVisible();
    // Says where the price comes from, in the row, because "Set prices" is
    // absent and that would otherwise read as something missing.
    await expect(row).toContainText('−10%');
    await expect(row.getByRole('button', { name: 'Set prices' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Remove prices' })).toHaveCount(0);
  });
});
