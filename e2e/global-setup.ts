import { HAVE_CREDS, NO_CREDS_MESSAGE } from "./tests/helpers";
import { BASE_URL } from "./playwright.config";

/**
 * Say what this run can and cannot check, before it checks it.
 *
 * A run where seven of ten tests silently show a dash is easy to mistake for a
 * pass. The banner makes the reason unmissable — and it names the variables to
 * export rather than making the operator read the source to find out.
 */
export default async function globalSetup(): Promise<void> {
  const line = "─".repeat(78);
  if (HAVE_CREDS) {
    console.log(`\n${line}\ne2e → ${BASE_URL} · signed in as E2E_EMAIL · READ-ONLY, nothing is written\n${line}\n`);
    return;
  }
  console.log(
    `\n${line}\n` +
      "e2e: SKIPPING every test that needs a session.\n\n" +
      NO_CREDS_MESSAGE +
      "\n\n  export E2E_EMAIL='operator@example.com'\n" +
      "  export E2E_PASSWORD='…'            # never commit this, never paste it into the repo\n" +
      `  export E2E_BASE_URL='${BASE_URL}'   # optional, this is the default\n\n` +
      "The signed-out tests below still run — they need no credentials.\n" +
      `${line}\n`,
  );
}
