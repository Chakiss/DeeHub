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

  test('says derived plans are not available rather than offering a broken one', async ({
    page,
  }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/rate-plans`);
    await page.getByRole('button', { name: 'Add rate plan' }).click();
    // Nothing computes a derived price, so a derived plan would store fine and
    // have no rates at all.
    await expect(page.locator('form')).toContainText(/Derived plans .* are not available yet/i);
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
    await page.getByLabel('From').fill(data.dates[3]!);
    await page.getByLabel('To (exclusive)').fill(data.dates[5]!);
    await page.getByRole('button', { name: 'Remove prices' }).click();

    // The dialog stays open and says how much of the hotel just went off sale.
    await expect(page.getByText('Removed 2 prices.')).toBeVisible();
    await expect(page.getByText(/2 nights can no longer be sold/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // Back to unsellable — NOT priced at zero.
    await page.goto(`/properties/${data.propertyId}/inventory?from=${data.dates[3]}`);
    const cleared = page.locator('tbody tr').filter({ hasText: 'Standard Twin' });
    await expect.poll(async () => cleared.textContent()).toContain('no rate');
    expect(await cleared.textContent()).not.toContain('1,500');
  });
});
