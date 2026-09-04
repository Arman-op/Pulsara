import { expect, test } from '@playwright/test';
import { e2eConfig } from '../playwright.config';

/**
 * Sign in, reach the dashboard, watch a live reading arrive.
 *
 * The flow is chosen because it is the one nothing else can cover. The API
 * suites drive Express against a real database with no browser; the component
 * suites drive React against a stubbed `fetch` with no server. Between them sit
 * the things that only break when both are real — a refresh cookie the browser
 * declines to store, a CORS origin that does not match, a WebSocket handshake
 * the client authenticates differently from how the server expects.
 *
 * The last assertion is the point of the whole product: a number on the screen
 * that came from a machine, and changes because the machine changed.
 */

async function signIn(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(e2eConfig.ADMIN_EMAIL);
  await page.getByLabel('Password').fill(e2eConfig.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('the dashboard', () => {
  test('signs in and shows telemetry from the real host', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

    /**
     * The live CPU reading is rendered only once a sample has arrived over the
     * socket, so seeing it proves the whole path: the client authenticated the
     * handshake with a token it holds only in memory, the server accepted it,
     * and the collector published a genuine `systeminformation` reading.
     */
    const liveReading = page.getByText(/^CPU \d+(\.\d+)?%$/);
    await expect(liveReading).toBeVisible({ timeout: 30_000 });

    // And it keeps arriving: a single value could be a fixture, a changing one
    // could not.
    const first = await liveReading.textContent();
    await expect
      .poll(async () => liveReading.textContent(), { timeout: 30_000, intervals: [1_000] })
      .not.toBe(first);
  });

  test('keeps the session across a reload rather than bouncing to login', async ({ page }) => {
    /**
     * The access token lives in memory only, so a reload starts with nothing and
     * the client has to exchange its HttpOnly cookie for a new one before it
     * routes. This is the assertion that the cookie was actually stored — a
     * missing `credentials: 'include'` passes every unit test and fails here.
     */
    await signIn(page);
    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();

    await page.reload();

    await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('refuses an unknown account', async ({ page }) => {
    // The endpoint this replaces accepted any address with the password
    // "password" and minted an administrator session for it.
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@pulsara.test');
    await page.getByLabel('Password').fill('password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText(/Sign-in failed/)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('sends an unauthenticated visitor to the login screen', async ({ page }) => {
    await page.goto('/alerts');
    await expect(page).toHaveURL(/\/login/);
  });

  test('shows a registered but unprobed service as unmeasured', async ({ page }) => {
    /**
     * The seed registers real probe targets, and this suite runs with probing
     * switched off — so the catalogue has services and nothing has observed any
     * of them. That is precisely the state the original dashboard papered over,
     * rendering six invented services with plausible uptime figures whenever it
     * had nothing real to show.
     *
     * An em dash is the correct answer. A percentage would be a lie.
     */
    await signIn(page);
    await page.getByRole('link', { name: 'Infrastructure' }).click();

    await expect(page.getByRole('heading', { name: 'Service Health' })).toBeVisible();
    await expect(page.getByText('not yet measured').first()).toBeVisible();
    await expect(page.getByText('— · —').first()).toBeVisible();
  });

  test('opens an incident and shows it on the feed', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Alerts' }).click();

    await expect(page.getByText(/No open incidents/)).toBeVisible();

    await page.getByRole('button', { name: 'Open an incident' }).click();
    await page.getByLabel('What is happening?').fill('Checkout is returning 500s');
    await page.getByRole('button', { name: 'Open incident', exact: true }).click();

    await expect(page.getByText('Checkout is returning 500s')).toBeVisible();
    // Raised by a person, and labelled as such.
    await expect(page.getByText('reported').first()).toBeVisible();
  });
});
