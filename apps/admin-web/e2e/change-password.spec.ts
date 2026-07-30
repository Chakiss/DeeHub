import { expect, test } from '@playwright/test';
import { TEST_PASSWORD, login, testData } from './helpers';

const NEW_PASSWORD = 'replacement-password-for-e2e';

/**
 * The dashboard half of the change-password flow.
 *
 * The API side is covered by the HTTP e2e suite; what these add is the BFF
 * cookie rewrite, which is the piece that fails silently. The API revokes every
 * session for the user as part of the change — including the caller's — so if
 * the route handler does not store the replacement pair, the user is signed out
 * by the act of securing their account and the only symptom is a redirect.
 *
 * Runs serially against its own dedicated user: these mutate a credential.
 */
test.describe.configure({ mode: 'serial' });

test.describe('change password', () => {
  test('changes the password, keeps the session, and invalidates the old one', async ({ page }) => {
    const data = testData();
    await login(page, data.passwordUserEmail);

    await page.goto('/account');
    await page.getByLabel('Current password').fill(TEST_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
    await page.getByLabel('Confirm new password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.getByRole('status')).toBeVisible();

    // Drop the access cookie so the next navigation MUST go through the
    // middleware's refresh path.
    //
    // Without this the assertion below is vacuous: an access token is a
    // stateless JWT that stays valid for its full 15 minutes, and the change
    // revokes refresh tokens only — so the page would load from the old cookie
    // even if the handler stored nothing at all. Forcing a refresh is what
    // actually proves the rotated refresh token was persisted; the stale one
    // was revoked by the password change and would redirect to /login.
    const kept = (await page.context().cookies()).filter(
      (cookie) => cookie.name !== 'deehub_at' && cookie.name !== 'deehub_exp',
    );
    await page.context().clearCookies();
    await page.context().addCookies(kept);

    await page.goto(`/properties/${data.propertyId}/inventory`);
    await expect(page).toHaveURL(/\/inventory/);

    // The new password works on a clean session.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.passwordUserEmail);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/properties\/.+\/inventory/);

    // And the old one no longer does.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.passwordUserEmail);
    await page.getByLabel('Password').fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('rejects a wrong current password', async ({ page }) => {
    const data = testData();
    // Runs after the test above, so the credential is NEW_PASSWORD by now.
    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.passwordUserEmail);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/properties\/.+\/inventory/);

    await page.goto('/account');
    await page.getByLabel('Current password').fill('not-the-current-password');
    await page.getByLabel('New password', { exact: true }).fill('another-valid-password');
    await page.getByLabel('Confirm new password').fill('another-valid-password');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('catches a mistyped confirmation before sending anything', async ({ page }) => {
    const data = testData();
    await page.goto('/login');
    await page.getByLabel('Organization').fill(data.organizationSlug);
    await page.getByLabel('Email').fill(data.passwordUserEmail);
    await page.getByLabel('Password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(/\/properties\/.+\/inventory/);

    let requested = false;
    await page.route('**/api/session/change-password', async (route) => {
      requested = true;
      await route.abort();
    });

    await page.goto('/account');
    await page.getByLabel('Current password').fill(NEW_PASSWORD);
    await page.getByLabel('New password', { exact: true }).fill('a-valid-new-password');
    await page.getByLabel('Confirm new password').fill('a-valid-new-passwordX');
    await page.getByRole('button', { name: 'Change password' }).click();

    await expect(page.locator('form').getByRole('alert')).toBeVisible();
    // A typo must not reach the server: it would change the password to
    // something the user does not know they typed.
    expect(requested).toBe(false);
  });
});
