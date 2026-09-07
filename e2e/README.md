# e2e — the console against a real stack

Ten Playwright tests that drive the **real operator console in a real browser against a
real running backend**. No mock, no MSW, no stubbed axios adapter appears anywhere in this
directory.

That is the entire reason it exists. `frontend/` has 409 tests and every one of them stubs
the network, so the hand-written wire types are the only thing holding the console to the
backend's contract — and a type cannot tell you what a live `core` actually answers. This
suite can. It is the gap `frontend/README.md` § "Known gaps" records as *"No end-to-end
test. Nothing exercises a real login against a running `core`."*

**It lives outside `frontend/` and `admin-frontend/` on purpose.** Neither app gains a
Playwright dependency, and `npm run check` in either stays exactly as fast as it was.

---

## What it covers

One line per test.

**`tests/auth-token-model.spec.ts` — the model `frontend/README.md` § "Auth" describes**

| test | what it proves against the live stack |
| --- | --- |
| sign-in writes no token to web storage, and `nb_refresh` is httpOnly | after a real UI sign-in, *neither* `localStorage` nor `sessionStorage` holds anything token-shaped (every entry is checked, not two remembered keys); `nb_refresh` exists in the browser context, is `httpOnly`, is scoped to `/auth`, and `document.cookie` cannot see it |
| a full page reload keeps the operator signed in | the in-memory access token dies with the reload, so surviving it can only come from the cookie bootstrap talking to the real `POST /auth/refresh` — which is asserted to answer 200 with a non-null token |
| sign out ends the session: the cookie is gone and a reload lands on login | `/auth/logout` succeeds, `nb_refresh` is no longer in the context, and a **reload** (not an in-memory flag) lands on the sign-in screen |

The first of those is the one that matters most. This console used to keep a 30-day refresh
token in `localStorage`; `lib/api.ts` still carries `purgeLegacyTokens()` to delete it from
installs that have one. Nothing until now could prove, in a browser, that the current build
does not put it back.

**`tests/signed-out.spec.ts` — needs no credentials, always runs**

| test | what it proves |
| --- | --- |
| loads the console with no 4xx or 5xx response at all | `/home` and `/` are loaded signed-out with the full network log captured; **zero** failing responses and zero failed requests. This is a documented design property, not a nicety — `/auth/refresh` is a session probe, so a signed-out visitor must produce no red line at all |
| `/auth/refresh` answers 200 with a null token — a probe, not an error | asserted on the response itself, from the live endpoint |
| nothing token-shaped is stored before anyone signs in | the baseline for the storage assertion above: a clean browser really is clean |

**`tests/wrong-password.spec.ts`**

| test | what it proves |
| --- | --- |
| shows the server's message and issues no session | one bad attempt → HTTP 401, the console renders core's own words (*"invalid email or password"*, `backend/core/app/auth/services/sessions.py`) rather than a generic banner, the URL stays on `/login`, and no refresh cookie was set |

Exactly **one** bad attempt is made, deliberately: core locks an account after
`lockout_max_attempts` (5) consecutive failures for 15 minutes, and a suite that locks the
operator out of their own live console would be worse than no suite.

**`tests/console-smoke.spec.ts` — three screens, three different backends**

| test | backend | endpoint |
| --- | --- | --- |
| Sites renders what core returned | `core` | `GET /api/v1/sites` |
| Cameras renders what vision returned | `vision` | `GET /api/v1/vms/federation/cameras` |
| Incidents renders what workflow returned | `workflow` | `GET /api/v1/workflow/instances` |

Each reads **the response that actually came over the wire** and then requires the DOM to
agree with it: the first row's own name, character for character, when the service returned
rows — the screen's honest empty state when it returned none. Not "a heading exists": a
heading renders perfectly while the API 500s. The Sites test additionally asserts the error
branch is *not* showing, because "a failed load is never an empty result" is a property this
console was fixed for once already.

## Rules this suite holds itself to

- **Read-only.** Nothing here creates, edits or deletes. It runs against the operator's live
  environment; a flow that would need a fixture is skipped and said so, never seeded.
- **No credentials in the repo.** `E2E_EMAIL` / `E2E_PASSWORD` come from the environment and
  from nowhere else. There is no default and no fallback. Missing → **skip**, with a banner
  naming the variables; a skip is honest ("we did not check"), a failure would be a lie
  ("the console is broken"). A failure message names a storage *key* and why it is suspect,
  never the value — an assertion must not become the exfiltration it complains about.
- **No arbitrary waits.** Every wait is on a response, a URL or a locator. The one that looks
  like a nicety is not: the login inputs are controlled React state, so filling them before
  hydration writes the DOM value, never reaches `onChange`, and submits an empty form. The
  suite waits on `/auth/setup-status` (fired from a `useEffect` on that page) as proof the
  effects have run. See `openLoginScreen` in `tests/helpers.ts`.
- **One sign-in per worker for the smoke flows** (`tests/fixtures.ts`), because core throttles
  `/auth/login` to 10 per minute per IP and a suite that spends that budget on itself starts
  failing for a reason that has nothing to do with the console. The session is held in a live
  browser context, never in a `storageState` file — that would drop a 30-day refresh token on
  disk beside the repo.
- **Nothing is started, stopped, built or restarted.** There is no `webServer` block.

## Running it

The stack must already be up (`neubit-v3-*`), and the console reachable at `E2E_BASE_URL`.

```bash
cd e2e
npm install
npx playwright install chromium      # chromium only — do not install all browsers

export E2E_EMAIL='operator@example.com'
export E2E_PASSWORD='…'              # never commit this; never paste it into the repo
export E2E_BASE_URL='http://localhost'   # optional, this is the default

npm test                 # the suite
npm run typecheck        # tsc --noEmit over the suite itself
npm run test:headed      # watch it drive the console
npm run report           # open the HTML report from the last run
npx playwright test tests/signed-out.spec.ts     # one file
npx playwright test -g "reload"                  # one test
```

`E2E_BASE_URL` must point at the **gateway** (`http://localhost`), not the frontend
container's `:3000` — that port serves the UI but 404s every `/api/v1` call, because the
console's API base is same-origin relative and only the gateway routes `/api`.

Without the credentials, the three signed-out tests still run and the other seven skip:

```
──────────────────────────────────────────────────────────────────────────────
e2e: SKIPPING every test that needs a session.

E2E_EMAIL and E2E_PASSWORD are not set — export them (and optionally E2E_BASE_URL,
default http://localhost) for an operator account on the running stack, then re-run.
See e2e/README.md. Never commit them.
──────────────────────────────────────────────────────────────────────────────
```

Failure artefacts (trace, screenshot, HTML report) land in `e2e/test-results/` and
`e2e/playwright-report/`, both gitignored. Open a trace with
`npx playwright show-trace test-results/…/trace.zip`.

## What this does **not** cover, and why

- **Every write path.** Creating a site, adding a camera or an NVR, raising or transitioning
  an incident, inviting a user, revoking a card — the flows an e2e suite most wants. They
  need a disposable deployment, not the operator's own; seeding data into a live environment
  to satisfy a test is not a trade this suite makes.
- **MFA, SSO, impersonation, password reset.** Each needs an account provisioned into a state
  no read-only run can reach (TOTP enrolled, an OIDC provider configured, a super-admin panel
  session, a mail sink).
- **Video.** Live streams, playback and the wall need a camera and a recorder; this
  deployment has neither registered, so the Cameras test exercises the honest empty state
  instead. With cameras present it asserts the first camera's real name.
- **The super-admin panel** (`admin-frontend/`), a different app with its own auth realm.
- **Anything under load.** One worker, serial, no retries.

## CI

**This suite is deliberately not wired into CI, and must not be.** There is no stack in CI —
the repo has no workflow that stands one up — and a test that cannot run is worse than a
missing test, because a permanently-skipped job reads as a passing one. Run it by hand
against a live deployment.

Putting it in CI needs three things, in this order:

1. **A stack per run.** `docker compose -f deploy/docker-compose.yml up -d --wait` on the
   runner, with the gateway published, plus enough disk and RAM for postgres, redis, nats and
   the eight services. `TILES_AUTO_PROVISION=0` so the job does not pull a multi-GB basemap
   it will never look at. Expect minutes, not seconds, before `http://localhost` answers.
2. **A seeded tenant with known credentials**, injected as repository secrets into
   `E2E_EMAIL` / `E2E_PASSWORD` — never committed, and belonging to that throwaway stack and
   nothing else. `VE_BOOTSTRAP_ADMIN_*` already creates the first admin at first start, so
   the seam exists.
3. **Then, and only then, the write coverage above** becomes possible: a disposable stack is
   exactly what makes create/edit/delete flows testable, and they are where the real
   contract drift will show up.

Two smaller things a CI job would also want: `retries: 1` (a cold `next dev` route compile
can take ~45s on first visit, which is why `timeout` here is 90s), and uploading
`playwright-report/` as an artefact so a red run is diagnosable without the machine.

## Layout

```
e2e/
├── playwright.config.ts   one chromium project, workers: 1, no webServer
├── global-setup.ts        the banner that says what this run can and cannot check
├── tsconfig.json          strict; `npm run typecheck` covers the suite itself
├── .env.example           the variable names; no value that is a secret
└── tests/
    ├── helpers.ts         credentials-from-env, sign-in/out, storage readers
    ├── fixtures.ts        the worker-scoped signed-in page
    ├── auth-token-model.spec.ts
    ├── signed-out.spec.ts
    ├── wrong-password.spec.ts
    └── console-smoke.spec.ts
```

## Each test was watched to fail

Per `frontend/README.md`: *"A test nobody has seen fail is not yet a test."* The frontend
container runs `next dev` with `frontend/src` bind-mounted, so a regression can be injected
into the running console and hot-reloaded without rebuilding anything.

| the regression injected | what went red |
| --- | --- |
| `lib/api.ts` `tokens.set()` also `localStorage.setItem("vizor.access", …)` — the exact old behaviour | *sign-in writes no token to web storage* → `+ "vizor.access (value is a JWT)"`. Note the message names the key and the reason, not the token |
| `lib/auth.tsx` `loadMe()` loses its `if (!(await bootstrapSession())) return` guard, so a signed-out visitor calls `/auth/me` with no token | *loads the console with no 4xx or 5xx response at all* → `+ "401 GET http://localhost/api/v1/auth/me"` |

Both files were restored byte-identical afterwards (verified by `shasum` and `git status`).
