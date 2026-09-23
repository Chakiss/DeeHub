import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { testDataPath, type TestData } from './fixtures';

function data(): TestData {
  return JSON.parse(readFileSync(testDataPath(), 'utf8')) as TestData;
}

/**
 * A guest's whole path on a phone: land from Google with dates filled in,
 * see the all-in price, hold the room, reach the payment page. No provider
 * is configured in tests, which is itself the case worth covering — the
 * booking is held and the page says the hotel will be in touch.
 */
test.describe('guest booking', () => {
  test('lands from Google with the dates and language it sent', async ({ page }) => {
    const d = data();
    const checkIn = d.dates[2]!;
    await page.goto(
      `/${d.organizationSlug}/${d.propertyCode}/rooms?checkin=${checkIn}&nights=2&adults=2&lang=en`,
    );
    // ?lang was consumed into the cookie and stripped from the URL.
    await expect(page).not.toHaveURL(/lang=/);
    await expect(page.getByRole('heading', { name: 'Rooms for your stay' })).toBeVisible();
    await expect(page.getByText('2 nights').first()).toBeVisible();
    // Two nights at ฿450, tax included: the desk-only ฿300 plan is not offered.
    await expect(page.getByText('฿900')).toBeVisible();
    await expect(page.getByText('Walk-in special')).toHaveCount(0);
    await expect(page.getByText('Free cancellation')).toBeVisible();
  });

  test("turns Google's landing link into the hotel's rooms page", async ({ page }) => {
    const d = data();
    const checkIn = d.dates[3]!;
    // The template in docs/google/landing-pages.xml, filled the way Google fills it.
    await page.goto(
      `/g/${d.propertyId}?checkin=${checkIn}&nights=1&adults=2&children=0&lang=en&rate=BAR&room=BUN&src=free`,
    );
    await expect(page).toHaveURL(new RegExp(`/${d.organizationSlug}/${d.propertyCode}/rooms\\?`));
    await expect(page).toHaveURL(/checkin=/);
    await expect(page.getByText('The rate you selected')).toBeVisible();
    await expect(page.getByText('฿450', { exact: true })).toBeVisible();

    // An id nobody issued goes to the company site rather than a 404.
    const stray = await page.request.get('/g/00000000-0000-4000-8000-000000000000', {
      maxRedirects: 0,
    });
    expect(stray.status()).toBe(302);
  });

  test('reads Thai by default and switches to English', async ({ page }) => {
    const d = data();
    await page.context().clearCookies();
    await page.goto(`/${d.organizationSlug}/${d.propertyCode}`, {
      // A Thai phone, as the default guest is.
    });
    await expect(page.getByRole('heading', { name: 'Sea Breeze Resort' })).toBeVisible();
    await expect(page.getByRole('button', { name: /ดูห้องว่าง|Check availability/ })).toBeVisible();
    await page.getByRole('link', { name: 'English' }).click();
    await expect(page.getByRole('button', { name: 'Check availability' })).toBeVisible();
    await expect(page.getByText('รีสอร์ตเงียบสงบ')).toHaveCount(0);
    await expect(page.getByText('A quiet resort near Huai Yai.')).toBeVisible();
  });

  test('shows the from-price strip and the hotel facts', async ({ page }) => {
    const d = data();
    await page.goto(`/${d.organizationSlug}/${d.propertyCode}?lang=en`);
    await expect(page.getByText('Prices for the next two weeks')).toBeVisible();
    await expect(page.getByText('฿450').first()).toBeVisible();
    await expect(page.getByText('1 king bed')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open in Google Maps' })).toHaveAttribute(
      'href',
      /maps\?q=12\.9236,100\.8825/,
    );
  });

  test('holds a room and is told the hotel will confirm', async ({ page }) => {
    const d = data();
    const checkIn = d.dates[5]!;
    await page.goto(
      `/${d.organizationSlug}/${d.propertyCode}/rooms?checkIn=${checkIn}&nights=1&adults=2&lang=en`,
    );
    await page.getByRole('link', { name: 'Book' }).first().click();
    await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
    // The final figure, once, in the currency — what Google's crawler reads.
    const final = page.locator('[data-nav-stage-final="true"] [itemprop="price"]');
    await expect(final).toHaveAttribute('content', '450.00');

    await page.getByLabel('Full name').fill('Ploy Sukhum');
    await page.getByLabel('Email').fill('ploy@example.test');
    await page.getByLabel('Phone').fill('0812345678');
    await page.getByRole('button', { name: 'Continue to payment' }).click();

    await expect(page).toHaveURL(/\/pay\/DH-[A-Z0-9]+\?email=/);
    await expect(page.getByText('This hotel does not take online payment yet.')).toBeVisible();
    await expect(page.getByText(/ploy@example\.test/)).toBeVisible();

    await page.getByRole('link', { name: 'Back to booking' }).click();
    await expect(page.getByRole('heading', { name: 'Booking received' })).toBeVisible();
    await expect(page.getByText(/^DH-[A-Z0-9]+$/)).toBeVisible();

    // Without the email, the page asks rather than tells.
    const url = new URL(page.url());
    url.searchParams.delete('email');
    await page.goto(url.toString());
    await expect(page.getByRole('heading', { name: 'Find a booking' })).toBeVisible();
    await page.getByLabel('Email used to book').fill('wrong@example.test');
    await page.getByRole('button', { name: 'Show booking' }).click();
    await expect(page.getByText('No booking matches that reference and email.')).toBeVisible();
  });
});
