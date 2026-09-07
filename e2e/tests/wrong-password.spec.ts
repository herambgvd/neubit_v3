import { expect, test } from "@playwright/test";

import { creds, openLoginScreen, refreshCookie, requireCreds } from "./helpers";

/**
 * A wrong password must report what the SERVER said and sign nobody in.
 *
 * Exactly one bad attempt is made, on purpose: core locks an account after
 * `lockout_max_attempts` (5) consecutive failures for 15 minutes, and a suite
 * that locks the operator out of their own live console is worse than no suite.
 */
test.describe("wrong password", () => {
  test.beforeEach(() => requireCreds());

  test("shows the server's message and issues no session", async ({ page }) => {
    await openLoginScreen(page);

    await page.locator("#email").fill(creds.email);
    // Not the real password, and not a guess at one: a value that cannot
    // collide with anything, so the failure is the point rather than luck.
    await page.locator("#password").fill(`not-the-password-${Date.now()}`);

    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/v1/auth/login") && r.request().method() === "POST",
        { timeout: 45_000 },
      ),
      page.getByRole("button", { name: /sign in/i }).click(),
    ]);

    expect(response.status()).toBe(401);

    // The console renders the backend's own words rather than a generic
    // "Login failed" — core answers "invalid email or password"
    // (backend/core/app/auth/services/sessions.py).
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();

    // Nobody was signed in: still on /login, and no refresh cookie was set.
    await expect(page).toHaveURL(/\/login$/);
    expect(await refreshCookie(page)).toBeUndefined();
  });
});
