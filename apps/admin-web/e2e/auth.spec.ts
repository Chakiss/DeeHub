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

  /**
   * The organization slug is the field nobody can remember — it is an
   * identifier the product chose, not something hotel staff know. After one
   * successful sign-in the everyday case becomes typing a password.
   */
  test('remembers the account and asks only for a password next time', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    // Asserted on the card as a whole: the fixture sets full_name to the
    // email, so the address legitimately renders twice inside it.
    const card = page.locator('form');
    await expect(card).toContainText(data.managerEmail);
    await expect(card).toContainText(data.organizationSlug);

    // Only the password is asked for.
    await expect(page.getByLabel('Organization')).toHaveCount(0);
    await expect(page.getByLabel('Email')).toHaveCount(0);

    await page.context().clearCookies({ name: 'deehub_at' });
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/properties\/.+\/inventory/);
  });

  test('never remembers an account after a failed attempt', async ({ page }) => {
    const data = testData();
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.managerEmail);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('form').getByRole('alert')).toBeVisible();

    // A typo must not become the suggestion on the next visit.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
    await expect(page.getByLabel('Organization')).toBeVisible();
  });

  test('forgetting the account restores the full form', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

    // Matters on a shared front-desk machine, where the address on screen
    // stops being yours.
    await page.getByRole('button', { name: 'Use another account' }).click();
    await expect(page.getByLabel('Organization')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toHaveCount(0);
  });

  test('the remembered account is not readable from client JavaScript', async ({
    page,
    context,
  }) => {
    const data = testData();
    await login(page, data.managerEmail);

    const remembered = (await context.cookies()).find((cookie) => cookie.name === 'deehub_last');
    expect(remembered, 'the account should be remembered').toBeTruthy();
    // It holds no credential, but an XSS bug should still not be able to lift a
    // colleague's address out of the browser.
    expect(remembered!.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('deehub_last');
  });

  /**
   * The logo is served from public/, which `output: standalone` does NOT copy —
   * the same trap as .next/static. It resolves from the source tree in
   * development and 404s in the container, so the only place this can be caught
   * is a request that actually fetches it.
   */
  test('serves the brand mark rather than a broken image', async ({ page }) => {
    await page.goto('/login');

    const logo = page.locator('img[src*="logo"]').first();
    await expect(logo).toBeVisible();

    const response = await page.request.get('/logo.png');
    expect(response.status(), 'the logo must be served, not 404').toBe(200);
    // A 404 page would still be "ok" to the browser; check it is really an image.
    expect(response.headers()['content-type']).toContain('image');
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
