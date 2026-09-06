# ops-agent

The privileged infrastructure sidecar. It is the only container that mounts
`/var/run/docker.sock`, so super-admins can list containers, tail logs, restart
services and back up or restore the control database from the platform UI without
that power living inside the internet-facing API.

It has no host port and no Traefik router: it is reachable only on the internal
`neubit` network. `core` proxies super-admin requests here behind its own
`require_superadmin` gate and adds `X-Ops-Token`.

## Routes

| | Auth | |
|---|---|---|
| `GET /health` | none | Liveness. Touches nothing. |
| `GET /readyz` | none | Readiness — pings the docker daemon, 503 if it is unreachable. |
| `GET /containers` | token | Every container in the compose project, with cpu/mem. |
| `GET /containers/{name}/logs` | token | Tail, clamped to 5000 lines. |
| `POST /containers/{name}/{restart,stop,start}` | token | Lifecycle. |
| `POST /services/{name}/scale` | token | **501** — see below. |
| `GET /host` | token | Container counts, plus host cpu/mem/disk when psutil is present. |
| `GET /db/export` | token | `pg_dump` of the control database. |
| `POST /db/import` | token | Restore a dump. Read the section below before touching it. |

## Things worth knowing

**The project whitelist is the safety rail.** A container outside the
`neubit-v3` compose project is invisible to `/containers` and answers **404** —
not 403 — on every by-id route, so unrelated host containers cannot be
enumerated. It matches the compose project label, with a name-prefix fallback for
containers not started by compose.

**`/db/import` is not a generic SQL runner, and it used to be.** `psql -f`
executes backslash meta-commands, so a body containing a shell escape ran a command
inside the postgres container — the one holding `pgdata` and the database
password. The sanitizer now allows only the meta-commands pg_dump itself emits
(`\.`, `\restrict`, `\unrestrict`, `\connect`) and **refuses** the dump otherwise
rather than stripping, because quietly editing what someone believes they are
restoring is its own problem. It tracks `COPY … FROM stdin` blocks, since data
lines there can begin with anything and only `\.` ends the block.

The dump is capped (`OPS_AGENT_MAX_DUMP_BYTES`, 512 MiB), staged under a unique
name, and removed afterwards whether or not the restore succeeded. It is applied
with `--single-transaction` and `ON_ERROR_STOP=1`, so a failure rolls the whole
thing back instead of leaving a half-restored database.

**Handlers are `def`, not `async def`, on purpose.** Every docker SDK call blocks.
As `async def` they ran on the event loop, and `/containers` — which samples stats
per container — measured 35.3s for 20 containers against core's 30s client
timeout, so the feature always failed while also stalling everything else the
agent served. They now run in a threadpool with the stats calls concurrent: 4.1s
for the same 20.

**`/services/{name}/scale` returns 501.** Cloning a container's full config is only
sound for stateless workers, and there are none yet. It used to return 200 with
`ok: false`, so core audit-logged the scale as though it had happened.

**It does not load `.env`.** The compose service lists the eight variables it
actually reads. Loading the shared env file handed the container that holds the
docker socket `VE_JWT_SECRET`, `VE_SECRETS_KEY` and every other platform
credential it has no use for.

## Tests

```bash
./backend/ops-agent/run-tests.sh
```

68 tests, offline: a throwaway container from the shipped image, tree mounted
read-only, **no network and no docker socket**. A fake docker client stands in, so
nothing in the suite can reach a real daemon.

The two that matter most: the auth matrix (every privileged route × missing, empty
and wrong token), and the sanitizer — a real pg_dump survives intact while shell
and file meta-commands are refused, including indented ones and any that follow a
COPY block.

The auth matrix's route list is DERIVED FROM THE APP, not written out. It used to
be a hand-maintained list of nine, so a route added later to the container that
holds the docker socket would simply not have been covered, and nothing would have
said so. Everything not in `PUBLIC` (the two probes and the docs) has to refuse a
missing, empty and wrong token; adding an ungated route now fails three tests
instead of none.

## Configuration

`OPS_AGENT_TOKEN` (required — unset means every request is refused),
`COMPOSE_PROJECT`, `DB_SERVICE`, `POSTGRES_USER`, `POSTGRES_DB`,
`POSTGRES_PASSWORD`, `VE_LOG_LEVEL`, `OPS_AGENT_MAX_DUMP_BYTES`.
