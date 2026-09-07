import { test as base, type Page, type BrowserContext } from "@playwright/test";

import { signIn, HAVE_CREDS, NO_CREDS_MESSAGE } from "./helpers";

/**
 * A worker-scoped signed-in page.
 *
 * The read-only smoke flows do not each need their own sign-in, and there is a
 * concrete reason not to take one: core throttles /auth/login to 10 per minute
 * per client IP (`rate_limit_login_per_minute`), and a suite that spends that
 * budget on itself starts failing for a reason that has nothing to do with the
 * console. One UI sign-in per worker, reused.
 *
 * The session is held in memory in a browser context — never written to a
 * storageState file, which would put a 30-day refresh token on disk next to the
 * repo. It is disposed with the worker.
 */
export const test = base.extend<object, { signedIn: Page }>({
  signedIn: [
    async ({ browser }, use) => {
      if (!HAVE_CREDS) {
        // Nothing to sign in with. Hand the tests a page they will skip on.
        const ctx: BrowserContext = await browser.newContext();
        const page = await ctx.newPage();
        await use(page);
        await ctx.close();
        return;
      }
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await signIn(page);
      await use(page);
      await ctx.close();
    },
    { scope: "worker" },
  ],
});

export const expect = base.expect;
export { NO_CREDS_MESSAGE, HAVE_CREDS };
