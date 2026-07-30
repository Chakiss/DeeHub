import { expect, test } from '@playwright/test';
import { TEST_PASSWORD, login, testData } from './helpers';

/**
 * Team administration through the browser.
 *
 * Worth knowing before reading these: administering people is an
 * ORGANIZATION-wide permission. Every fixture user except the owner is scoped
 * to a property, which deliberately confers no authority over colleagues — so
 * the read-only cases here are about a property manager, not a junior role.
 */
test.describe.configure({ mode: 'serial' });

/** The login helper lands on inventory; the owner has no property nav. */
async function signInAsOwner(page: import('@playwright/test').Page): Promise<void> {
  const data = testData();
  await page.goto('/login');
  await page.getByLabel('Organization').fill(data.organizationSlug);
  await page.getByLabel('Email').fill(data.ownerEmail);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.describe('team', () => {
  test('lists colleagues without exposing any credential', async ({ page }) => {
    const data = testData();
    await signInAsOwner(page);

    await page.goto('/team');
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
    // Scoped to the row: the fixture sets full_name to the email, so the value
    // legitimately appears in two columns.
    await expect(page.getByRole('row', { name: new RegExp(data.managerEmail) })).toBeVisible();

    // A password hash must never be one serialisation away from the page.
    const html = await page.content();
    expect(html).not.toContain('passwordHash');
    expect(html).not.toContain('password_hash');
  });

  test('creates a colleague and shows the one-time password once', async ({ page }) => {
    await signInAsOwner(page);
    await page.goto('/team');

    await page.getByRole('button', { name: 'Add colleague' }).click();
    // Scoped to the dialog: each table row also has a "Role — <email>" select.
    const form = page.getByRole('dialog', { name: 'Add colleague' });
    const email = `hired-${Date.now().toString(36)}@e2e.test`;
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Full name').fill('New Hire');
    await form.getByLabel('Role', { exact: true }).selectOption('FRONT_DESK');
    await form.getByRole('button', { name: 'Save' }).click();

    // Shown here and nowhere else — it is not stored in readable form.
    const dialog = page.getByRole('dialog', { name: 'Account created' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(email);
    await dialog.getByRole('button', { name: 'Close' }).click();

    await expect(page.getByRole('row', { name: new RegExp(email) })).toBeVisible();
  });

  test('offers no control for changing your own role or status', async ({ page }) => {
    const data = testData();
    await signInAsOwner(page);
    await page.goto('/team');

    const ownRow = page.getByRole('row', { name: new RegExp(data.ownerEmail) });
    await expect(ownRow).toBeVisible();
    // Locking yourself out is always a mistake, never an intent.
    await expect(ownRow.getByRole('button', { name: 'Disable' })).toHaveCount(0);
    await expect(ownRow).toContainText('cannot change your own');
  });

  /**
   * This used to be an unhandled server error. `/auth/me` reports capabilities
   * as the union across memberships — what someone can do SOMEWHERE — so a
   * property-scoped manager looked entitled to the organization-wide list and
   * the page crashed on the API's refusal.
   */
  test('explains the refusal instead of failing, for a property-scoped user', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto('/team');
    await expect(page.getByRole('heading', { name: 'Team' })).toBeVisible();
    await expect(page.getByText('You do not have access to the team list')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add colleague' })).toHaveCount(0);
  });
});
