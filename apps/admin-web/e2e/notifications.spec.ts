import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * The delivery log through the browser.
 *
 * Nothing is composed here: messages are written by the outbox relay, which is
 * a worker process the browser suite does not run. What this covers is the
 * screen itself — that the route renders, the navigation reaches it, and an
 * empty log explains what would fill it rather than showing a blank page.
 * Composition and delivery are covered against a real database in
 * `apps/api/src/modules/notifications/notifications.e2e.test.ts`.
 */

test.describe('notifications', () => {
  test('is reachable from the property menu', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/reservations`);
    await page.getByRole('link', { name: 'Notifications' }).click();

    await page.waitForURL(/\/notifications$/);
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  });

  test('explains an empty log rather than showing nothing', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/notifications`);

    await expect(page.getByText('Nothing has been sent yet')).toBeVisible();
    await expect(page.getByText(/Messages are written when a booking/)).toBeVisible();
  });

  test('offers the failure filters, because failures are the point', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);
    await page.goto(`/properties/${data.propertyId}/notifications`);

    await page.getByRole('link', { name: /^Failed/ }).click();
    await page.waitForURL(/status=FAILED/);
    await expect(page.getByText('No messages with that status')).toBeVisible();
  });
});
