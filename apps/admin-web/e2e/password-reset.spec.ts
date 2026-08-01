import { expect, test } from '@playwright/test';
import { seedResetToken } from './fixtures';
import { TEST_PASSWORD, testData } from './helpers';

const NEW_PASSWORD = 'recovered-password-for-e2e';

/**
 * The dashboard half of self-service recovery.
 *
 * The API side is covered by `password-reset.e2e.test.ts`; what these add is
 * the part only a browser can show — that the two pages are reachable with no
 * session at all, that the confirmation says nothing about whether the account
 * exists, and that a link actually lands somewhere a person can finish.
 *
 * Tokens are planted rather than read from mail: the raw value exists only in
 * the email, which is the property the whole design rests on.
 *
 * Serial, against its own dedicated user: these mutate a credential.
 */
test.describe.configure({ mode: 'serial' });

test.describe('password reset', () => {
  test('is reachable from the sign-in screen without a session', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');

    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  });

  test('says the same thing for an unknown address as for a real one', async ({ page }) => {
    const data = testData();
    await page.context().clearCookies();

    await page.goto('/forgot-password');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.recoveryUserEmail);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const real = await page.locator('main').textContent();

    await page.goto('/forgot-password');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill('nobody-at-all@e2e.test');
    await page.getByRole('button', { name: 'Send the link' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const unknown = await page.locator('main').textContent();

    // Identical but for the address echoed back, which the person typed.
    expect(unknown?.replace('nobody-at-all@e2e.test', 'X')).toBe(
      real?.replace(data.recoveryUserEmail, 'X'),
    );
  });

  test('a link sets a new password and returns the person to sign in', async ({ page }) => {
    const data = testData();
    const token = await seedResetToken(data, data.recoveryUserEmail);

    await page.context().clearCookies();
    await page.goto(`/reset-password?token=${token}`);

    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();

    // Back to sign in, with the slug carried over — it is the field nobody
    // remembers, and this person has just proved they were locked out.
    await page.waitForURL(/\/login\?/);
    await expect(page.getByLabel('Organization')).toHaveValue(data.organizationSlug);
    await expect(page.getByText('Your password has been changed.')).toBeVisible();

    // No session came from the link itself.
    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === 'deehub_at')).toBe(false);

    await page.getByLabel('Email').fill(data.recoveryUserEmail);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/properties\/.+\/inventory/);
  });

  test('the old password no longer works', async ({ page }) => {
    const data = testData();
    await page.context().clearCookies();

    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.recoveryUserEmail);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a spent link is refused, and offers a way to get another', async ({ page }) => {
    const data = testData();
    const token = await seedResetToken(data, data.recoveryUserEmail);
    await page.context().clearCookies();

    for (const attempt of ['first', 'second'] as const) {
      await page.goto(`/reset-password?token=${token}`);
      await page.getByLabel('New password', { exact: true }).fill(`${NEW_PASSWORD}-${attempt}`);
      await page.getByLabel('Confirm new password').fill(`${NEW_PASSWORD}-${attempt}`);
      await page.getByRole('button', { name: 'Set password' }).click();

      if (attempt === 'first') {
        await page.waitForURL(/\/login\?/);
      }
    }

    await expect(page.locator('form').getByRole('alert')).toContainText('no longer valid');
  });

  test('catches a mistyped confirmation before spending the link', async ({ page }) => {
    const data = testData();
    const token = await seedResetToken(data, data.recoveryUserEmail);
    await page.context().clearCookies();

    let requested = false;
    await page.route('**/api/session/reset-password', async (route) => {
      requested = true;
      await route.abort();
    });

    await page.goto(`/reset-password?token=${token}`);
    await page.getByLabel('New password', { exact: true }).fill('a-valid-new-password');
    await page.getByLabel('Confirm new password').fill('a-valid-new-passwordX');
    await page.getByRole('button', { name: 'Set password' }).click();

    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    // The link is single-use, so a typo that reached the server would cost the
    // person another trip to their mailbox.
    expect(requested).toBe(false);
  });

  test('explains itself when the link arrives without a token', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/reset-password');

    await expect(page.getByRole('heading', { name: 'This link is incomplete' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Send me another link' })).toBeVisible();
  });
});
