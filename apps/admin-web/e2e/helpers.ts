import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { TEST_PASSWORD, testDataPath, type TestData } from './fixtures';

export function testData(): TestData {
  return JSON.parse(readFileSync(testDataPath(), 'utf8')) as TestData;
}

/**
 * Log in through the real form.
 *
 * Deliberately not a cookie shortcut: the login path is itself one of the
 * things worth testing, and a shortcut would let it rot unnoticed.
 */
export async function login(page: Page, email: string): Promise<void> {
  const data = testData();
  await page.goto('/login');
  await page.getByLabel('Organization').fill(data.organizationSlug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/properties\/.+\/inventory/);
}

export { TEST_PASSWORD };
