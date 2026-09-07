import { expect, test, type Page, type Response } from "@playwright/test";

/**
 * Credentials come from the environment and ONLY from the environment.
 *
 * There is no default, no fallback and nothing credential-shaped committed to
 * this repo. If the operator has not exported them, every test that needs a
 * session SKIPS with the message below — a skip is honest ("we did not check"),
 * a failure would be a lie ("the console is broken").
 */
export const creds = {
  email: process.env.E2E_EMAIL || "",
  password: process.env.E2E_PASSWORD || "",
};

export const HAVE_CREDS = !!(creds.email && creds.password);

export const NO_CREDS_MESSAGE =
  "E2E_EMAIL and E2E_PASSWORD are not set — export them (and optionally E2E_BASE_URL, " +
  "default http://localhost) for an operator account on the running stack, then re-run. " +
  "See e2e/README.md. Never commit them.";

/** Skip the current test when no credentials were supplied. */
export function requireCreds(): void {
  test.skip(!HAVE_CREDS, NO_CREDS_MESSAGE);
}

/** The httpOnly refresh cookie the backend sets at login (core/app/auth/cookies.py). */
export const REFRESH_COOKIE = "nb_refresh";

/**
 * Sign in through the real UI — typing into the real form and letting the real
 * console call the real /auth/login. Deliberately NOT an API call with the
 * cookie injected: the point is to exercise what an operator actually does.
 *
 * Waits on the login response and on the /home URL, never on a timeout.
 */
export async function signIn(page: Page): Promise<Response> {
  await openLoginScreen(page);

  await page.locator("#email").fill(creds.email);
  await page.locator("#password").fill(creds.password);

  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/v1/auth/login") && r.request().method() === "POST",
      { timeout: 45_000 },
    ),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);

  // A password this suite cannot use is an operator problem, not a console bug —
  // say which, without ever echoing the secret.
  if (response.status() !== 200) {
    throw new Error(
      `Sign-in for E2E_EMAIL failed with HTTP ${response.status()}. ` +
        "Check the credentials in the environment (the password is never printed).",
    );
  }

  await page.waitForURL("**/home", { timeout: 45_000 });
  return response;
}

/**
 * Open /login and wait until the form is actually WIRED, not merely painted.
 *
 * This matters and it is not a timing nicety: the inputs are controlled React
 * state. Filling them before hydration writes the DOM value but never reaches
 * the onChange handler, so the component still holds "" and the submit is
 * rejected by client-side validation with no request at all. Observed once
 * while writing this suite, which is why the wait is on a signal rather than a
 * duration: /auth/setup-status is fired from a useEffect on this page, so its
 * response proves the effects have run and the handlers are attached.
 */
export async function openLoginScreen(page: Page): Promise<void> {
  const hydrated = page.waitForResponse((r) => r.url().includes("/api/v1/auth/setup-status"), {
    timeout: 45_000,
  });
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await hydrated;
}

/**
 * Open the account menu and click Sign out.
 *
 * The header carries several `aria-haspopup="menu"` buttons (the navigator, the
 * account menu, …) and only one of them holds Sign out; find it by what it
 * contains rather than by an index that a header change would silently shift.
 */
export async function signOut(page: Page): Promise<Response> {
  // Scope to the header: outside it lives the Next dev-tools launcher, which
  // also advertises aria-haspopup="menu" and would otherwise be menu #0.
  const menus = page.locator('header button[aria-haspopup="menu"]');
  const signOutButton = page.getByRole("button", { name: /sign out/i });
  // The header mounts after the route does, so wait for it to exist before
  // counting — counting an unmounted header finds nothing and proves nothing.
  await menus.first().waitFor({ state: "visible", timeout: 30_000 });
  const count = await menus.count();
  let opened = false;
  for (let i = 0; i < count; i++) {
    await menus.nth(i).click();
    // The dropdown mounts on a React state change, so poll the locator rather
    // than reading it once — a bounded wait on the element, never a sleep.
    try {
      await signOutButton.waitFor({ state: "visible", timeout: 2_000 });
      opened = true;
      break;
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  if (!opened) throw new Error("No header menu offers Sign out — the account menu moved.");

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/auth/logout"), { timeout: 45_000 }),
    signOutButton.click(),
  ]);
  await page.waitForURL("**/login", { timeout: 45_000 });
  return response;
}

/** Everything the browser can see from JavaScript, for the storage assertions. */
export async function readClientStorage(page: Page): Promise<{
  local: Record<string, string>;
  session: Record<string, string>;
  documentCookie: string;
}> {
  return page.evaluate(() => {
    const dump = (s: Storage): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null) out[k] = s.getItem(k) ?? "";
      }
      return out;
    };
    return { local: dump(localStorage), session: dump(sessionStorage), documentCookie: document.cookie };
  });
}

/**
 * "Token-shaped" — a JWT, or a value stored under a key that advertises itself
 * as a credential. Both halves matter: the old build wrote `vizor.access` /
 * `vizor.refresh` (key-shaped AND JWT-shaped), and a future regression might
 * write a raw token under an innocent key.
 */
const JWT_RE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const CREDENTIAL_KEY_RE = /(^|[._-])(access|refresh|bearer|jwt|id)?_?token|nb_refresh|vizor\.(access|refresh)/i;

export function tokenShapedEntries(store: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(store)) {
    // Report the KEY and why, never the value — a failure message must not
    // become the exfiltration it is complaining about.
    if (JWT_RE.test(value.trim())) hits.push(`${key} (value is a JWT)`);
    else if (CREDENTIAL_KEY_RE.test(key)) hits.push(`${key} (key names a credential)`);
    else if (/"(access|refresh)_token"\s*:/.test(value)) hits.push(`${key} (value embeds a *_token field)`);
  }
  return hits;
}

/** Read the nb_refresh cookie from the browser CONTEXT (httpOnly ones live only here). */
export async function refreshCookie(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name === REFRESH_COOKIE);
}
