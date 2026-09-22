import { readFileSync } from 'node:fs';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
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

  // The browser may already remember an account, which replaces the full form
  // with a password-only card. Switching to a different colleague means saying
  // it is not you — exactly what a person does at a shared front desk.
  const useAnother = page.getByRole('button', { name: 'Use another account' });
  if (await useAnother.isVisible().catch(() => false)) {
    await useAnother.click();
  }

  await page.getByLabel('Organization').fill(data.organizationSlug);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/properties\/.+\/inventory/);
}

const API = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

export async function apiToken(request: APIRequestContext, email?: string): Promise<string> {
  const data = testData();
  const response = await request.post(`${API}/auth/login`, {
    data: {
      organizationSlug: data.organizationSlug,
      email: email ?? data.managerEmail,
      password: TEST_PASSWORD,
    },
  });
  return ((await response.json()) as { accessToken: string }).accessToken;
}

/**
 * Open allotment and price a range of nights, for a spec that books.
 *
 * The fixture seeds one shared window (`data.dates`) that the inventory spec
 * asserts exact figures on, so a spec that creates bookings must open nights
 * of its OWN rather than consume those — otherwise it changes what another
 * spec sees, depending on the order they happen to run in.
 */
export async function openForSale(
  request: APIRequestContext,
  token: string,
  from: string,
  to: string,
): Promise<void> {
  const data = testData();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  const inventory = await request.patch(`${API}/properties/${data.propertyId}/inventory`, {
    headers,
    data: { updates: [{ roomTypeId: data.roomTypeId, from, to, allotment: 5 }] },
  });
  expect(inventory.ok(), await inventory.text()).toBeTruthy();

  const rates = await request.patch(`${API}/properties/${data.propertyId}/rates`, {
    headers,
    data: {
      updates: [
        {
          ratePlanId: data.ratePlanId,
          from,
          to,
          prices: [
            { occupancy: 1, amount: 90000 },
            { occupancy: 2, amount: 120000 },
          ],
        },
      ],
    },
  });
  expect(rates.ok(), await rates.text()).toBeTruthy();
}

export { TEST_PASSWORD };
