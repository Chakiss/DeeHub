import { expect, test } from '@playwright/test';
import { TEST_PASSWORD, login, testData } from './helpers';

test.describe('authentication', () => {
  test('redirects an unauthenticated visitor to login and returns them afterwards', async ({
    page,
  }) => {
    const data = testData();
    const target = `/properties/${data.propertyId}/reservations`;

    await page.goto(target);
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.managerEmail);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Returned to where they were going, not dumped on the home page.
    await expect(page).toHaveURL(new RegExp(target.replace(/\//g, '\\/')));
  });

  test('rejects a wrong password without revealing whether the account exists', async ({
    page,
  }) => {
    const data = testData();
    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.managerEmail);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the form: Next always renders a route announcer with
    // role="alert", so an unscoped query is ambiguous.
    const alert = page.locator('form').getByRole('alert');
    await expect(alert).toBeVisible();
    const wrongPassword = await alert.textContent();
    expect(wrongPassword).toBeTruthy();
    await expect(page).toHaveURL(/\/login/);

    // Same message for an account that does not exist at all.
    await page.getByLabel('Email').fill('nobody@e2e.test');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(alert).toHaveText(wrongPassword!);
  });

  test('never exposes a token to client-side JavaScript', async ({ page, context }) => {
    const data = testData();
    await login(page, data.managerEmail);

    // The dashboard is a backend-for-frontend: session cookies must be
    // httpOnly, so an XSS bug cannot read them.
    const cookies = await context.cookies();
    const session = cookies.filter((cookie) => cookie.name.startsWith('deehub_'));
    expect(session.length).toBeGreaterThan(0);
    for (const cookie of session) {
      expect(cookie.httpOnly, `${cookie.name} must be httpOnly`).toBe(true);
    }

    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain('deehub_at');
    expect(visible).not.toContain('deehub_rt');

    // And no token leaked into the rendered HTML either.
    expect(await page.content()).not.toContain('Bearer ');
  });

  test('signing out ends the session', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    // The old page must no longer be reachable by going back.
    await page.goto(`/properties/${data.propertyId}/inventory`);
    await expect(page).toHaveURL(/\/login/);
  });
});
