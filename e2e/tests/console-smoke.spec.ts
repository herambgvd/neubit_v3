import { expect, test } from "./fixtures";
import { requireCreds } from "./helpers";

/**
 * Read-only smoke flows across three DIFFERENT backends, to prove the console
 * and the services still agree at run time:
 *
 *   Sites     → core     GET /api/v1/sites
 *   Cameras   → vision   GET /api/v1/vms/federation/cameras
 *   Incidents → workflow GET /api/v1/workflow/instances
 *
 * The assertion in each is deliberately NOT "a heading exists" — a heading
 * renders perfectly well while the API 500s. Each test reads the response that
 * actually came over the wire and then requires the DOM to agree with it: the
 * first row's own name when the service returned rows, the screen's honest
 * empty state when it returned none. Either way the page is being held to the
 * live payload rather than to a shape this test invented.
 *
 * NOTHING here creates, edits or deletes. This runs against the operator's live
 * environment; a flow that would need a fixture is skipped, not seeded.
 */
test.describe("read-only smoke flows", () => {
  test.beforeEach(() => requireCreds());

  test("Sites renders what core returned", async ({ signedIn: page }) => {
    const wire = page.waitForResponse(
      (r) => /\/api\/v1\/sites\?/.test(r.url()) && r.request().method() === "GET",
      { timeout: 45_000 },
    );
    await page.goto("/sites");
    const response = await wire;
    expect(response.status(), "core refused GET /sites").toBe(200);

    const body = (await response.json()) as { items: { name: string }[]; total: number };

    if (body.items.length > 0) {
      // The name in the DOM is the name core sent, character for character.
      await expect(page.getByText(body.items[0].name, { exact: false }).first()).toBeVisible();
    } else {
      // No sites is a legitimate state — but it must be SAID, not implied by a
      // blank panel, and it must not be what a failed load looks like.
      await expect(page.getByText(/no sites yet/i)).toBeVisible();
    }
    // A failed load is never an empty result (frontend/README.md § Testing).
    await expect(page.getByText(/couldn't load sites/i)).toHaveCount(0);
  });

  test("Cameras renders what vision returned", async ({ signedIn: page }) => {
    const wire = page.waitForResponse(
      (r) => r.url().includes("/api/v1/vms/federation/cameras") && r.request().method() === "GET",
      { timeout: 45_000 },
    );
    await page.goto("/devices/cameras");
    const response = await wire;
    expect(response.status(), "vision refused GET /vms/federation/cameras").toBe(200);

    const body = (await response.json()) as { items: { name: string }[]; total: number };

    if (body.items.length > 0) {
      await expect(page.getByText(body.items[0].name, { exact: false }).first()).toBeVisible();
    } else {
      await expect(page.getByText(/no cameras/i).first()).toBeVisible();
    }
  });

  test("Incidents renders what workflow returned", async ({ signedIn: page }) => {
    const wire = page.waitForResponse(
      (r) => /\/api\/v1\/workflow\/instances\?/.test(r.url()) && r.request().method() === "GET",
      { timeout: 45_000 },
    );
    await page.goto("/events");
    const response = await wire;
    expect(response.status(), "workflow refused GET /workflow/instances").toBe(200);

    const body = (await response.json()) as {
      items: { name: string | null; sop_name: string }[];
      total: number;
    };

    // The header counts what the API said it is showing — a number the page can
    // only get right by reading the response.
    await expect(page.getByText(new RegExp(`showing\\s+${body.items.length}\\s+incident`, "i"))).toBeVisible();

    if (body.items.length > 0) {
      const first = body.items[0];
      await expect(page.getByText(first.name || first.sop_name, { exact: false }).first()).toBeVisible();
    } else {
      await expect(page.getByText(/no active alarms/i)).toBeVisible();
    }
  });
});

/**
 * NOT COVERED, on purpose — every one of these needs to WRITE to the live stack:
 * creating a site, adding a camera or an NVR, raising or transitioning an
 * incident, inviting a user, revoking a card. They are the flows an e2e suite
 * most wants, and they need a disposable deployment (compose up + a seeded
 * tenant) rather than the operator's own. See e2e/README.md § "What this does
 * not cover".
 */
