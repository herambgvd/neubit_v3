import { expect, test, type Request, type Response } from "@playwright/test";

import { openLoginScreen, readClientStorage, refreshCookie, tokenShapedEntries } from "./helpers";

/**
 * "A signed-out visitor produces zero failing requests" is a DESIGN PROPERTY of
 * this console, written down in frontend/README.md § "Auth": /auth/refresh is a
 * session probe that answers 200 with a null token rather than 401. It is easy
 * to break — one component that fetches before checking the session, or a
 * backend that starts 401-ing the probe — and until now nothing tested it,
 * because a stubbed adapter cannot tell you what a real server answers.
 *
 * Needs no credentials: being signed out is the whole point.
 */
test.describe("signed-out visitor", () => {
  test("loads the console with no 4xx or 5xx response at all", async ({ page }) => {
    const failures: string[] = [];
    const record = (r: Response) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    };
    const netErrors: string[] = [];
    const failed = (r: Request) => netErrors.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`);

    page.on("response", record);
    page.on("requestfailed", failed);

    // /home is the console's own landing route: signed out it must resolve the
    // session, find none, and route to /login — all without anything failing.
    await page.goto("/home", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/login$/);

    // And the marketing root, which mounts the same providers.
    await page.goto("/", { waitUntil: "networkidle" });

    expect(failures, "a signed-out visitor made a failing request").toEqual([]);
    expect(netErrors, "a signed-out visitor made a request that never completed").toEqual([]);
  });

  test("/auth/refresh answers 200 with a null token — a probe, not an error", async ({ page }) => {
    const probe = page.waitForResponse(
      (r) => r.url().includes("/api/v1/auth/refresh") && r.request().method() === "POST",
      { timeout: 45_000 },
    );
    await page.goto("/home");
    const response = await probe;

    expect(response.status()).toBe(200);
    expect((await response.json()).access_token).toBeNull();
  });

  test("nothing token-shaped is stored before anyone signs in", async ({ page }) => {
    await openLoginScreen(page);

    const { local, session, documentCookie } = await readClientStorage(page);
    expect(tokenShapedEntries(local)).toEqual([]);
    expect(tokenShapedEntries(session)).toEqual([]);
    expect(documentCookie).not.toContain("nb_refresh");
    expect(await refreshCookie(page)).toBeUndefined();
  });
});
