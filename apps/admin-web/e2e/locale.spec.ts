import { expect, test } from '@playwright/test';
import { login, testData } from './helpers';

/**
 * Thai is a Phase 3 roadmap item and the reason next-intl was wired on day one
 * (ADR-0003). English stays the default; switching is explicit and remembered.
 */
test.describe('language', () => {
  test('switches the sign-in page to Thai before anyone signs in', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    // The first screen a Thai receptionist meets, so the switch has to work
    // without an account.
    await page.getByLabel('Language').selectOption('th');
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
    await expect(page.getByLabel('รหัสองค์กร')).toBeVisible();
  });

  test('remembers the choice across a reload', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Language').selectOption('th');
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();
  });

  test('translates the menu and the screens behind it', async ({ page }) => {
    const data = testData();
    await login(page, data.managerEmail);

    await page.goto(`/properties/${data.propertyId}/inventory`);
    await page.getByLabel('Language').selectOption('th');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'ห้องว่าง' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'ผังการเข้าพัก' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ห้องว่าง' })).toBeVisible();
  });

  test('goes back to English', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel('Language').selectOption('th');
    await expect(page.getByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeVisible();

    await page.getByLabel('Language').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
