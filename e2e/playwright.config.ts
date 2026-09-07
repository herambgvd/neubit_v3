import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration for the Neubit operator console.
 *
 * This suite talks to a REAL running stack — there is no mock, no MSW, no stubbed
 * adapter anywhere in it. That is the whole point: the 409 tests in `frontend/`
 * all stub the network, so nothing there can prove the console and the backend
 * still agree at run time. These tests can.
 *
 * Consequences:
 *   • There is no `webServer` block. Nothing here starts, stops, builds or
 *     restarts anything — the stack is the operator's live environment.
 *   • It is NOT wired into CI (see README.md § "CI").
 *   • Credentials come from the environment only. A missing credential SKIPS,
 *     it does not fail and it never falls back to a default.
 */
export const BASE_URL = process.env.E2E_BASE_URL || "http://localhost";

export default defineConfig({
  testDir: "./tests",
  // Prints the banner that says whether this run can check the signed-in half.
  globalSetup: "./global-setup.ts",
  // The stack is shared and read-only here; serialising keeps the login rate and
  // the network logs legible, and makes a failure reproducible on its own.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  // The frontend container runs `next dev`, so a route the suite is first to visit
  // compiles on demand — a cold /devices/cameras has been seen to take ~45s.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    // A signed-out visitor must produce no failing request — that assertion is
    // only honest if the browser starts with nothing.
    storageState: { cookies: [], origins: [] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ignoreHTTPSErrors: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
