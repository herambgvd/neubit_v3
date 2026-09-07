import { expect, test } from "@playwright/test";

import {
  REFRESH_COOKIE,
  readClientStorage,
  refreshCookie,
  requireCreds,
  signIn,
  signOut,
  tokenShapedEntries,
} from "./helpers";

/**
 * The token model, against the real backend.
 *
 * frontend/README.md § "Auth" states it: the ACCESS token lives only in memory
 * (a module variable in `src/lib/api.ts`) and rides as a Bearer header; the
 * REFRESH token is the httpOnly `nb_refresh` cookie, scoped to /auth and
 * invisible to JavaScript. `lib/api.test.ts` pins that against a stubbed
 * adapter. Nothing until now pinned it against a browser and a live `core`.
 */
test.describe("token model", () => {
  test.beforeEach(() => requireCreds());

  test("sign-in writes no token to web storage, and nb_refresh is httpOnly", async ({ page }) => {
    await signIn(page);

    const { local, session, documentCookie } = await readClientStorage(page);

    // This console USED to keep a 30-day refresh token in localStorage. That
    // regression must be impossible to reintroduce unnoticed, so the assertion
    // is on the whole of both stores, not on the two keys we happen to remember.
    expect(
      tokenShapedEntries(local),
      "localStorage holds something token-shaped after sign-in",
    ).toEqual([]);
    expect(
      tokenShapedEntries(session),
      "sessionStorage holds something token-shaped after sign-in",
    ).toEqual([]);

    // The refresh cookie exists — in the browser context, where httpOnly ones live.
    const cookie = await refreshCookie(page);
    expect(cookie, `no ${REFRESH_COOKIE} cookie after sign-in`).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.path).toContain("/auth");

    // …and JavaScript cannot see it. This is the half that makes httpOnly mean
    // anything: an XSS on this console reads nothing that outlives the tab.
    expect(documentCookie).not.toContain(REFRESH_COOKIE);
  });

  test("a full page reload keeps the operator signed in", async ({ page }) => {
    await signIn(page);

    // The in-memory access token dies with the reload, so staying signed in can
    // only come from the cookie bootstrap talking to the real /auth/refresh.
    const refreshed = page.waitForResponse(
      (r) => r.url().includes("/api/v1/auth/refresh") && r.request().method() === "POST",
      { timeout: 45_000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const probe = await refreshed;

    expect(probe.status()).toBe(200);
    expect((await probe.json()).access_token, "refresh returned no access token").toBeTruthy();

    // Still on the console, not bounced to /login.
    await expect(page).toHaveURL(/\/home$/);
    // And the operator's identity came back from the server, not from a cache.
    await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
  });

  test("sign out ends the session: the cookie is gone and a reload lands on login", async ({
    page,
  }) => {
    await signIn(page);
    expect(await refreshCookie(page)).toBeDefined();

    const logout = await signOut(page);
    expect(logout.status()).toBeLessThan(400);

    expect(
      await refreshCookie(page),
      `${REFRESH_COOKIE} survived sign-out — the session is still resumable`,
    ).toBeUndefined();

    // A reload is the honest check: an in-memory "signed out" flag would pass
    // without it. Nothing should be left to bootstrap from.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });
});
