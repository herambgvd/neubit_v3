# workflow

The SOP / incident-automation engine. An event arrives on the NATS spine, this
service decides whether it starts an incident, runs that incident through the SOP's
state machine, escalates it when it goes stale, and sends the notifications the SOP
asks for.

**It does not do webhook / event ingestion.** The previous version of this file
said it did. That was true once and has been false for a long time — `ingest` is
its own service, with its own database, its own HMAC-signed inbound endpoints and
its own README. Workflow is downstream of it and speaks to it only through NATS.
If you came here looking for the code that receives an external webhook, it is not
in this directory and adding some here would be the wrong repair.

Control-plane service on the `edge` core. REST behind Traefik under
`/api/v1/workflow/...`; cross-domain traffic is NATS events, never HTTP.

## What it owns

Thirteen tables in its own database, `neubit_workflow`. Nothing else writes them
and this service writes nothing else.

| | |
|---|---|
| `sops`, `workflow_states`, `workflow_transitions` | the playbook: the state machine an operator draws |
| `workflow_triggers`, `alert_formats` | the two ways an event becomes an incident — by event type + conditions, or by alert code |
| `workflow_instances` | a running incident |
| `workflow_forms` | dynamic form definitions attached to states |
| `notification_templates`, `notification_channels`, `notifications`, `device_tokens` | templates, per-tenant provider config, the outbox, mobile push registrations |
| `threat_levels` | the site threat-posture register |
| `correlation_dedup` | firing-dedup slots for triggers, swept on a schedule |

Every table but `correlation_dedup` carries a nullable `tenant_id` (NULL = a
platform / super-admin row) and every read and write goes through
`kernel.auth`'s `scoped` / `assert_owned`. A table without the mixin is a table
that leaks — see `app/workflow/core/mixins.py`.

## Three processes, one image

`workflow`, `workflow-worker` and `workflow-beat` are three containers built from
the same Dockerfile, and they are separate because the failure modes are separate.

* **api** (`uvicorn app.main:app`) — the REST surface. It also runs `alembic
  upgrade head` before binding, which is why its healthcheck has a 90s grace
  period, and why the worker is gated on the api being *healthy* rather than
  started: "started" would let a sweep run against a half-migrated schema. It
  optionally hosts the NATS consumers in-process (`VE_WORKFLOW_INLINE_CORRELATION`,
  on in compose today).
* **worker** (`celery … worker`) — the sweeps (escalation, timeout, notification
  dispatch, dedup cleanup) and the long-running consumers.
* **beat** (`celery … beat`) — the schedule that publishes those sweeps.

Neither Celery process has a web framework and neither should grow one, but both
run a ~40-line stdlib probe server on `:8000` because a wedged Celery worker has no
outward symptom at all: the process is up, the broker connection is established, and
`celery inspect ping` answers *pong* straight through the wedge, because ping is
served by the control consumer on a broadcast queue rather than by the one carrying
work. The worker's liveness signal is `task_postrun` (a task *completed*) and beat's
is `before_task_publish` (a task was *sent*); read together they name which
container is broken. `cbee3fb` and `app/probes.py` have the windows and the
reasoning.

`/health` is liveness and touches nothing outside the process. `/readyz` asks the
database, the Celery broker and each NATS durable and answers 503 naming the one
that failed. Compose gates on `/readyz`; they are not the same question and one
endpoint cannot mean both.

## Layout, and the boundary that is enforced

One package per feature under `app/workflow/`, each holding its own
`models` / `schemas` / `service` / `router`, so a change to one subject is a change
inside one directory (`fa18bb2`). Two packages are explicitly not features: `core/`
(the shared vocabulary and pure rules — the leaf, imports no feature and not even
`app.db`) and `runtime/` (process plumbing: the event bus, the per-run task
session). Two files sit at the top to be the one place something is listed:
`router.py` (mount order) and `tables.py` (every model module, so Alembic sees all
thirteen tables).

The direction is `core` ← features ← `instances` ← `correlation`, and it is not a
convention: `tests/test_package_boundaries.py` parses the import graph and fails on
any edge that runs against the table (`cd14988`). Deferred (function-local) imports
count as edges — a lazy import is not a way around the rule, it is a way to write
down why, and a deliberate back-edge goes in `DEFERRED_BACK_EDGES` with its reason
and is itself checked for still being real. Adding a feature package is one line in
`MAY_IMPORT`; there is no test logic to edit.

`tests/test_route_permissions.py` guards the other claim `router.py` makes, that
every endpoint is gated by a `workflow.*` permission. It walks the resolved FastAPI
dependant tree rather than the source, so a gate hidden behind a shared
sub-dependency counts and a gate on a dependency FastAPI never reaches does not.

## Tests

154 → 172, all offline: no Postgres, no NATS, no SMTP server. DB-backed tests build
an in-memory SQLite engine holding only the tables they name (`tests/conftest.py`),
which is why the models use portable column types.

```bash
docker compose cp backend/workflow/tests workflow:/app/tests
docker exec neubit-v3-workflow-1 sh -c \
  'pip install -q pytest pytest-asyncio aiosqlite && cd /app && python -m pytest tests -q -rxs'
```

Locally: `pip install -e .[dev]` (which pulls `aiosqlite` — without it the suite
collects fine and then fails every DB-backed test at `create_async_engine`), then
`python -m pytest tests -q`.

## Things that will surprise you

**The notification outbox is drained by a CLAIM, not a SELECT.** Every worker
replica runs the same sweep on the same minute; a plain "select pending, send,
mark sent" delivers every notification once per replica (`b6ac372`). The drain
instead claims a batch with `FOR UPDATE SKIP LOCKED` and commits `status='claimed'`
*before* sending. That commit is what turns a lock into a **lease**: once the
transaction ends the row is no longer locked, so `claimed` is what keeps the next
worker off it and `claimed_at` is what stops that being forever. A worker that dies
mid-send leaves a row nothing drains, so `_reclaim_expired` returns claims older
than `VE_WORKFLOW_NOTIFY_CLAIM_LEASE` (600s) to `pending`. Too low and a merely slow
send is reclaimed while it is still in flight, which is the double-send this
prevents; too high and a real alert waits. See `notifications/jobs.py`.

**Channel credentials are encrypted at rest and the marker is deliberate.** The
cipher is `kernel.secrets` (per-tenant key derived from `VE_SECRETS_KEY`);
`notifications/secrets.py` owns the only part that is workflow's — *which* keys of a
provider-shaped config blob are credentials, and it is selective on purpose so the
host, port and URL stay readable to whoever is debugging the channel. Ciphertext is
stored as `enc:v1:<token>`. A value **without** the marker is returned unchanged,
because deployments hold rows written before encryption existed and a deploy that
cannot read what it wrote yesterday is an outage. A value **with** the marker that
will not decrypt **raises** — that is an operator who rotated `VE_SECRETS_KEY`, and
handing back the ciphertext there means an SMTP password of `gAAAAAB…` reaches a
mail server and the log says "authentication failed". Read `43ff0f5` before touching
this; the leniency is not an exception handler.

**`sops.initial_state` is a derived pointer, not the truth.** The truth is the
state row flagged `is_initial`, and `0007_one_initial_state` holds *at most one per
SOP* with a partial unique index (`NULLS NOT DISTINCT`, because a NULL `tenant_id`
is a real platform row and not an absence). The pointer is maintained by
`StateService._sync_pointer` — it was never set and then NULLed (`edf407e`), and it
was writable through `PATCH /sops` until `7ebd9f2`, which meant an operator could
point a SOP at a state that was not its initial one and launches would start in the
wrong place. It is not accepted from the API. Do not add it back to an update
schema.

**An empty `workflow_triggers.event_type` matches EVERY event type.** The engine
reads `if not t.event_type or t.event_type in event_types`. It is intentional and
it is also why a trigger that looks half-configured is not inert — it is the
loudest trigger you have.

**`--loglevel` on the Celery command line is inert.** Both Celery processes
configure `kernel.logging` at import and claim Celery's `setup_logging` signal, so
verbosity is `VE_LOG_LEVEL` for all three containers. This has to happen at import
rather than from `worker_ready`, because the prefork pool has already forked by then
and a child keeps the handlers its parent held at the fork — configure late and only
`MainProcess` changes while every task line keeps Celery's format. Log lines are
human-readable text everywhere including production; `VE_LOG_FORMAT=json` opts in
to one JSON object per line when there is a shipper to read it.

**`alembic revision --autogenerate` must come back EMPTY.** It never once did until
`0008_notnull_repair` — sixteen columns were NOT NULL in the models and nullable in
the table, because `sa.Column(..., server_default=...)` in `0001` does not imply
`nullable=False`. If you find it noisy again, that noise is a real drift and the
next person after you will not be able to review a schema change through it. Fix it
rather than learning to read past it.

## Configuration

Everything is `VE_`-prefixed and shared with the rest of the estate through
`deploy/.env` — `VE_DATABASE_URL`, `VE_REDIS_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`,
`VE_SECRETS_KEY`. Service-specific knobs live next to the code that reads them:
`VE_WORKFLOW_INLINE_CORRELATION`, `VE_WORKFLOW_INLINE_NOTIFY`,
`VE_WORKFLOW_PROBE_PORT`, `VE_WORKFLOW_NOTIFY_CLAIM_LEASE`,
`VE_WORKFLOW_WORKER_SILENCE_SEC`, `VE_WORKFLOW_BEAT_SILENCE_SEC`,
`VE_LOG_LEVEL`, `VE_LOG_FORMAT`.

See `../../docs/SERVICES.md` for where this sits in the estate.
