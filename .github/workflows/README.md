# CI

`ci.yml` runs on every push to `main` and every pull request. Ten jobs, no
dependencies between them, each named for what it gates — a red X names the thing
that broke.

| job | gates | run the same thing locally |
| --- | --- | --- |
| `frontend (console)` | operator console: `tsc --noEmit`, eslint **errors**, 1772 vitest tests, committed icon + basemap assets, `next build` | `cd frontend && npm ci && npm run check && npm run icons:check && npm run map:assets:check && npm run build` |
| `admin-frontend (super-admin console)` | super-admin console: types, eslint **errors**, 295 vitest tests, `next build` | `cd admin-frontend && npm ci && npm run check && npm run build` |
| `backend / core` | 587 tests | `cd deploy && docker compose build core && cd .. && ./backend/core/run-tests.sh` |
| `backend / access` | 266 tests | `cd deploy && docker compose build access && cd .. && ./backend/access/run-tests.sh` |
| `backend / ingest` | 181 tests | `cd deploy && docker compose build ingest && cd .. && ./backend/ingest/run-tests.sh` |
| `backend / vision` | 746 tests | `cd deploy && docker compose build vision && cd .. && ./backend/vision/run-tests.sh` |
| `backend / workflow` | 290 tests (+4 skipped) | `cd deploy && docker compose build workflow && cd .. && ./backend/workflow/run-tests.sh` |
| `backend / reading-writer` | 188 tests | `cd deploy && docker compose build reading-writer && cd .. && ./backend/reading-writer/run-tests.sh` |
| `backend / ops-agent` | 68 tests | `cd deploy && docker compose build ops-agent && cd .. && ./backend/ops-agent/run-tests.sh` |
| `backend / kernel` | 100 tests (+1 skipped) — the shared SDK, run inside access's test image | `./backend/access/run-tests.sh && ./backend/kernel/run-tests.sh` |

2,426 backend tests, 704 frontend tests. All of it passes on `HEAD` today; that is
the number CI holds.

## Things worth knowing before you edit this

**Lint gates errors, not warnings.** Both consoles are at **0 eslint errors**, and
that is what the build fails on. They also carry warnings — ~242 in the console
(~100 of them `react-hooks/set-state-in-effect`), 1 in the super-admin panel — and
those are a *deliberate, documented* backlog: see "Known gaps" in
`frontend/README.md`. Do not "fix" this by adding `--max-warnings 0`. That does not
raise the bar, it just makes `main` permanently red for a refactor nobody has
scheduled.

**`npm ci` is strict — no `--legacy-peer-deps`.** It needed the flag while
`@vitejs/plugin-react` was on 4, whose peer range stopped at vite `^6` while the
lock hoisted vite 7; `npm ci` refused the lock before installing anything. The
plugin is on `^5` now (peer range `^4 || ^5 || ^6 || ^7`) and the lock resolves
cleanly. If a peer conflict reappears, fix the manifest — the flag would hide the
kind of drift this job exists to catch.

**The console suites need the whole repo.** `frontend/src/test/contract.test.ts`
and `admin-frontend/src/test/contract.test.ts` read the Pydantic response models
out of `backend/*/app/**.py` at run time — that is the only thing holding the
hand-written TS types to the backend's contract. A sparse or `frontend/`-only
checkout turns that file into a thousand failures. `actions/checkout@v4` with no
`sparse-checkout` is load-bearing.

**The backend jobs run `run-tests.sh`, unchanged.** Read
`backend/core/run-tests.sh` top to bottom before touching those jobs: the suite
runs in a throwaway container built from the *service image* plus a test runner,
with the working tree mounted read-only and `--network none`. There is no
`pip install` step in CI and there must not be one — the service image is the
environment, which is what makes a green run mean something. CI's only additions
are (a) building the image the script needs and (b) `cp deploy/.env.example
deploy/.env`, because `docker compose build` interpolates that file and hard-fails
without it. Those values are throwaway; nothing in CI starts the stack.

**No databases, no service containers.** Every suite in the matrix runs
`--network none` against sqlite/in-memory fakes. `backend/workflow/run-tests.sh`
has an opt-in `--pg` mode that joins the running compose network and talks to a
real Postgres; CI does not use it, because doing so would mean standing up
Timescale plus `deploy/.env` secrets to re-run assertions the sqlite path already
covers.

**Docker layer cache.** The backend jobs build through `docker buildx bake` on the
compose file rather than `docker compose build`, purely so layers can be exported
to `actions/cache` — compose build cannot export a cache. Same compose file, same
context, same Dockerfile, same resulting image tag (`neubit-v3-<service>:latest`,
because the compose project is named `neubit-v3`), so the scripts find their image
with no environment overrides. The test-runner image each script builds on top
(`tests/Dockerfile.test`, one `pip install pytest` layer) is not cached between
runs; it costs seconds.

## Deliberately NOT in CI

Left out rather than faked. Each line says what adding it would take.

- **`npm run map:verify` (frontend).** Smoke-tests a *running* deployment's map
  against a multi-GB PMTiles planet archive that ships as a deployment volume, not
  a repo artifact. It would need the stack up and the archive mounted. Its offline
  half — `npm run map:assets:check`, the committed glyphs and sprites — *is* gated,
  in the frontend job.
- **`backend/workflow/run-tests.sh --pg`.** Needs Postgres/Timescale on the compose
  network plus real `POSTGRES_USER`/`POSTGRES_PASSWORD` from `deploy/.env`. Adding
  it means a `services: postgres:` container using the Timescale image and CI-only
  credentials.
- **End-to-end anything.** There is no test that logs into a running `core` from a
  running console; `frontend/README.md` records that gap. It would take the stack
  up (gateway, core, postgres, nats, redis) plus a browser driver.
- **The Go NVR.** It lives in a sibling repository, not this one. Gating it means
  a workflow there (or a submodule/checkout of it here) — either way a decision
  about repo layout, not something to bolt on quietly.
- **Image publishing / deploys.** This workflow only gates. It pushes nothing,
  needs no secrets, and has `permissions: contents: read`.
