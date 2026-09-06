# reading-writer

The process that fills `neubit_reporting`. The schema itself belongs to the
[`reporting`](../reporting) package, which this service imports and never
redeclares — one owner for the readings schema, in one place.

Two surfaces, deliberately different kinds of thing:

* **Operational** — `/health`, `/readyz`, `/metrics`, `/stats`. Not routed through
  the gateway; an operator reaches them on the container port.
* **Tenant API** — `{api_prefix}/bi/...`, the Building Intelligence read API. JWT,
  the tenant's `analytics` module, an unexpired licence, and `bi.read` per route.
  SELECT-only: this service is still the only thing that WRITES the schema, and
  there is one query path over this store.

The BI API is here rather than in a service of its own because the platform bans
cross-service reads — a separate analytics container would have to SELECT tables
it does not own.

## Six consumers, one process

| consumer | stream | subject |
|---|---|---|
| `pipeline` | IOT_READINGS | `tenant.*.iot.reading.>` → readings / points |
| `projections` | EVENTS + IOT_READINGS | one durable per `reporting_projections` row |
| `placement_sync` | EVENTS | `tenant.*.sites.device_placement.>` |
| `site_facts_sync` | EVENTS | `tenant.*.sites.site.>` |
| `dlq_watch` | EVENTS_DLQ | `dlq.>` (observes; writes nothing) |
| `offboard` | EVENTS | `tenant.*.tenant.offboarded` → the right-to-erase |

`pipeline` is the hot path — every device reading in the estate — and the rule is
one-way: a projection backlog must never delay a reading being written. That is
held by four things, none of which is "separate containers", because they are not:
a separate NATS connection each, separate durables, separate asyncio tasks with
bounded queues, and a separate connection pool. The pool is the one the merge
actually exposed; a shared one would let a projection block the readings write
loop in the pool CHECKOUT, before any statement is issued, where no
`statement_timeout` applies and no health flag is armed.

The full argument, and the measurements behind the readiness rules, are in
`app/main.py`'s module docstring.

## Readiness

`/readyz` is what to page on. It goes red when EITHER half is wedged and every
reason names which one, because a single verdict computed from one half's numbers
reports success while the other is silently dead.

The states it can see that a naive check cannot: a fetch loop that stopped
answering (a heartbeat on every ANSWERED pull, so a dead task goes stale — an
assigned flag cannot notice, since a dead task assigns nothing), and a durable that
is gone or is not ours (nats-py reports the server's 409 as a plain `TimeoutError`,
identical to an idle feed, so a durable deleted out of band is invisible at the
fetch call without a second proof from `consumer_info`).

It also goes red if the right-to-erase consumer failed to subscribe. An offboard
arriving while it is unsubscribed is not queued for us — the durable does not
exist, so nothing is holding the message.

## Startup never dies on a bus failure

Every consumer's start is caught and logged. A writer that exits on a NATS hiccup
takes its `/metrics` and `/readyz` with it, and then the outage is invisible. Stay
up, stay red.

## Redundancy

Scale it: `docker compose up -d --scale reading-writer=2`. Every replica binds the
SAME durable name — readings and each projection alike — so NATS distributes
between them. No leader election, nothing per replica. Drop the host port binding
if you scale beyond one.

## Tests

```bash
./backend/reading-writer/run-tests.sh
```

136, offline: a throwaway container from the shipped image, tree mounted read-only,
no network. Pure — nothing here touches a database.

## Known gaps

* `/bi/datasets`, `/bi/datasets/{key}`, `/bi/datasets/{key}/values`, `/bi/query`
  and `/bi/query/capabilities` reach the store before they know which permission
  applies, because a dataset declares its own permission key in the registry
  TABLE — that is the point of the registry, and it means the gate cannot be a
  fixed dependency. They filter rather than refuse: `/bi/datasets` OMITS what the
  caller may not read, which is asserted in `test_route_inventory.py`.
* The suite is otherwise pure and needs no database. Anything that needs the real
  schema needs Postgres: the reporting models use JSONB, which SQLite cannot
  compile, so `create_all` against sqlite fails outright.

## Configuration

`VE_DATABASE_URL`, `VE_NATS_URL`, `VE_JWT_SECRET`, plus the pipeline knobs in
`app/config.py` (`VE_READINGS_*`) and the projector's in
`app/projections/config.py` (`VE_PROJECTOR_*`, including
`VE_PROJECTOR_RELOAD_SEC`, which is how long a newly registered projection waits
before it starts consuming).
