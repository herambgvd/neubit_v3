"""What the workflow service knows about itself, for both of its entry points.

WHY /health AND /readyz ARE TWO ENDPOINTS AND MUST STAY TWO. Somebody will
eventually look at these and want to "simplify" them into one. They answer
different questions and have different consequences:

    /health   LIVENESS. "Is this process alive and running its own code?" It
              touches nothing outside the process — no database, no Redis, no
              NATS, no clock arithmetic that can be wrong. A failing liveness
              probe is a restart signal, so it must NEVER go red for a dependency
              outage: restarting a healthy API because Postgres is down turns one
              outage into two, and a restart loop during a database blip is how a
              recoverable incident becomes a total one.

    /readyz   READINESS. "Would work sent here actually get done?" It checks the
              dependencies this process cannot work without, and returns 503 with
              a reason NAMING the one that failed. A failing readiness probe means
              stop sending traffic / stop gating on this — not restart.

              Deliberately NOT part of the API's readiness: the Celery worker's
              liveness. The API can serve every request correctly while the worker
              is wedged; failing the API for it would take the console offline for
              a fault the console did not cause and cannot fix. The worker reports
              its own readiness on its own port, and the API exposes the worker's
              age in /metrics and in the readiness BODY as advisory context.

The old ``/health`` returned ``{"status": "ok", ...}`` unconditionally. With
Postgres, Redis and NATS all down it still returned ok, and there was no /readyz
at all — so "the workflow service is up" was a statement about nothing.

THE WORKER AND BEAT HAVE NO HTTP SERVER, so this also provides a ~40-line stdlib
one for them. The alternatives were considered and rejected:

  * ``celery inspect ping`` as the healthcheck. It is answered by the worker's
    CONTROL consumer on a broadcast queue — a different consumer on a different
    queue from the one that carries tasks. It returns pong for a worker whose task
    queue has been cancelled, which is the exact wedge being probed for, so it is
    structurally a liar here. (Proven: the verification for this commit cancels
    the task consumer and shows ping still answering.)
  * a touched file plus a healthcheck that stats it. Works, but gives the worker
    no /metrics, and Prometheus cannot scrape a mtime.
  * no probe on worker/beat at all, gating them on the API's. That is what
    existed, and it is why a wedged worker looked identical to a working one.

A thread running ``http.server`` costs one socket and no dependency, and makes the
worker scrapeable like everything else on this platform.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sqlalchemy import text

from kernel.config import get_settings

from app.workflow.runtime import heartbeat
from app.workflow.runtime.consumers import ConsumerWatch

log = logging.getLogger("workflow.probes")

STARTED_AT = time.time()

# Dependency checks get a hard ceiling. A readiness probe that blocks is a
# readiness probe that times out at the orchestrator instead of answering, and
# "no answer" and "answered 503 naming Postgres" are very different to the person
# reading it at 3am.
CHECK_TIMEOUT_SEC = 3.0

# Lag past which a durable is called behind. The correlation feed is domain
# events, not telemetry: a few hundred queued means something stopped, not that a
# busy afternoon is being absorbed.
CONSUMER_LAG_WARN = 500
# How long a durable may go unconfirmed before it counts as wedged. Six polls of
# ConsumerWatch's 10s timer, so a single blip or a NATS reconnect cannot trip it.
CONSUMER_SILENCE_SEC = 60.0


# ── the individual checks ────────────────────────────────────────────────────


async def check_database() -> str | None:
    """None when the database answers. Otherwise the reason, for the 503 body."""
    from app.db import get_engine

    try:
        async def _ping() -> None:
            async with get_engine().connect() as conn:
                await conn.execute(text("SELECT 1"))

        await asyncio.wait_for(_ping(), timeout=CHECK_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        # Distinguished from a refused connection on purpose: a database that
        # accepts the socket and then never answers is a different fault (lock
        # wait, saturated pool, a SIGSTOPped server) from one that is simply down.
        return f"database: no answer to SELECT 1 within {CHECK_TIMEOUT_SEC}s"
    except Exception as e:  # noqa: BLE001
        return f"database: {type(e).__name__}: {e}"[:300]
    return None


async def check_broker() -> str | None:
    """None when the Celery broker answers PING.

    This is the SAME Redis the worker and beat use, so a failure here explains a
    stale worker heartbeat rather than duplicating it — which is why the readiness
    body reports both and does not collapse them.
    """
    try:
        import redis.asyncio as aredis

        client = aredis.Redis.from_url(
            get_settings().redis_url, socket_connect_timeout=CHECK_TIMEOUT_SEC,
            socket_timeout=CHECK_TIMEOUT_SEC,
        )
        try:
            await asyncio.wait_for(client.ping(), timeout=CHECK_TIMEOUT_SEC)
        finally:
            await client.aclose()
    except asyncio.TimeoutError:
        return f"celery broker: Redis did not answer PING within {CHECK_TIMEOUT_SEC}s"
    except Exception as e:  # noqa: BLE001
        return f"celery broker: {type(e).__name__}: {e}"[:300]
    return None


# ── the API process's view ───────────────────────────────────────────────────


class ApiProbes:
    """Assembles the API's readiness and metrics.

    Holds the ``ConsumerWatch`` for whichever consumers this process is hosting.
    When ``VE_WORKFLOW_INLINE_CORRELATION`` is off they are hosted elsewhere and
    this reports so EXPLICITLY rather than reporting green: "not checked here" and
    "checked and fine" must not look the same, or turning the flag off would
    silently delete the check.
    """

    def __init__(self) -> None:
        self.watches: list[ConsumerWatch] = []
        self.hosts_consumers = False

    def add(self, watch: ConsumerWatch) -> None:
        self.watches.append(watch)
        self.hosts_consumers = True

    async def start_watches(self) -> None:
        for w in self.watches:
            await w.start()

    async def close(self) -> None:
        for w in self.watches:
            await w.close()
        await heartbeat.close_reader()

    async def readiness(self) -> tuple[bool, dict]:
        """(ready, body). Every reason names the dependency, in reading-writer style."""
        db, broker = await asyncio.gather(check_database(), check_broker())
        reasons = [r for r in (db, broker) if r]
        for w in self.watches:
            reasons.extend(w.reasons())

        worker, worker_err = await heartbeat.read("worker")
        beat, beat_err = await heartbeat.read("beat")
        body = {
            "ready": not reasons,
            "reasons": reasons,
            "service": "workflow",
            "role": "api",
            "uptime_sec": round(time.time() - STARTED_AT, 1),
            "database": "ok" if db is None else db,
            "broker": "ok" if broker is None else broker,
            "consumers": (
                {w.label: w.snapshot() for w in self.watches}
                if self.hosts_consumers
                else "not hosted in this process (VE_WORKFLOW_INLINE_CORRELATION off)"
            ),
            # Advisory, NOT part of `ready` — see the module docstring.
            "worker": _role_view("worker", worker, worker_err, heartbeat.WORKER_SILENCE_SEC),
            "beat": _role_view("beat", beat, beat_err, heartbeat.BEAT_SILENCE_SEC),
        }
        return not reasons, body

    async def metrics(self) -> str:
        from app.db import get_engine
        from app.workflow.notifications import backlog as backlog_mod

        parts: list[str] = [
            "# HELP workflow_uptime_sec Seconds since this API process started.",
            "# TYPE workflow_uptime_sec gauge",
            f"workflow_uptime_sec {round(time.time() - STARTED_AT, 1)}",
        ]

        # ── notification backlog ──
        try:
            from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

            sm = async_sessionmaker(get_engine(), expire_on_commit=False, class_=AsyncSession)
            async with sm() as session:
                b = await backlog_mod.backlog(session)
            parts.append(backlog_mod.prometheus(b))
            db_up = 1
        except Exception as e:  # noqa: BLE001
            # A scrape must still return the OTHER families when one source is
            # down. Losing the whole exposition because Postgres is unreachable
            # would hide the very consumer metrics that explain why.
            log.warning("metrics: notification backlog unavailable: %s", e)
            db_up = 0
        parts.append(
            "# HELP workflow_db_healthy 1 when the last metrics scrape could read the "
            "outbox. 0 means the numbers above are stale, not that they are zero.\n"
            "# TYPE workflow_db_healthy gauge\n"
            f"workflow_db_healthy {db_up}"
        )

        # ── correlation / notify consumer lag ──
        if self.watches:
            parts.append("# HELP workflow_consumers_hosted 1 when this process runs the "
                         "NATS consumers. 0 means the series below are absent, not zero.\n"
                         "# TYPE workflow_consumers_hosted gauge\nworkflow_consumers_hosted 1")
            from app.workflow.runtime import consumers as consumers_mod

            parts.append(consumers_mod.help_block())
            for w in self.watches:
                parts.append(w.prometheus())
        else:
            parts.append("# HELP workflow_consumers_hosted 1 when this process runs the NATS "
                         "consumers.\n# TYPE workflow_consumers_hosted gauge\n"
                         "workflow_consumers_hosted 0")

        # ── worker + beat liveness, read from the shared broker ──
        parts.append(await _role_metrics())
        return "\n".join(p.rstrip("\n") for p in parts) + "\n"


def _role_view(role: str, payload: dict | None, err: str | None, limit: float) -> dict:
    age = heartbeat.age_of(payload)
    return {
        "seen": payload is not None,
        # Kept apart from `seen`: "the broker is unreachable" and "this process has
        # never published" are the same None and two different investigations.
        "read_error": err,
        "last_event_age_sec": age,
        "last_event_name": (payload or {}).get("last_event_name"),
        "events_total": (payload or {}).get("events_total"),
        "failures_total": (payload or {}).get("failures_total"),
        "silence_limit_sec": limit,
        "consuming" if role == "worker" else "publishing": (
            age is not None and age < limit
        ),
    }


async def _role_metrics() -> str:
    lines = [
        "# HELP workflow_worker_consuming 1 while the Celery worker has COMPLETED a task "
        "within VE_WORKFLOW_WORKER_SILENCE_SEC. Not a traffic gauge: beat publishes two "
        "sweeps every minute forever, so an estate with no incidents still reads 1. 0 "
        "means the task queue is not being consumed — which `celery inspect ping` "
        "answers pong to, because that is a different consumer on a different queue.",
        "# TYPE workflow_worker_consuming gauge",
        "# HELP workflow_worker_last_task_age_sec Seconds since the worker last finished a "
        "task. Falls back to process age before the first task, so a fresh worker is not "
        "reported as infinitely silent.",
        "# TYPE workflow_worker_last_task_age_sec gauge",
        "# HELP workflow_beat_publishing 1 while beat has PUBLISHED a task within "
        "VE_WORKFLOW_BEAT_SILENCE_SEC. Read with workflow_worker_consuming: beat 1 + "
        "worker 0 is a wedged worker; both 0 is a dead beat or a dead broker.",
        "# TYPE workflow_beat_publishing gauge",
        "# HELP workflow_beat_last_publish_age_sec Seconds since beat last published a task.",
        "# TYPE workflow_beat_last_publish_age_sec gauge",
        "# HELP workflow_worker_tasks_total Tasks the worker has completed since it started.",
        "# TYPE workflow_worker_tasks_total counter",
        "# HELP workflow_worker_task_failures_total Tasks that ended in FAILURE.",
        "# TYPE workflow_worker_task_failures_total counter",
        "# HELP workflow_heartbeat_seen 1 when a heartbeat for this role could be read from "
        "the broker at all. 0 covers never-published, expired, and Redis unreachable — all "
        "three mean nothing can be said about that process.",
        "# TYPE workflow_heartbeat_seen gauge",
    ]
    for role, limit in (("worker", heartbeat.WORKER_SILENCE_SEC),
                        ("beat", heartbeat.BEAT_SILENCE_SEC)):
        payload, _err = await heartbeat.read(role)
        age = heartbeat.age_of(payload)
        alive = int(age is not None and age < limit)
        lines.append(f"workflow_heartbeat_seen{{role=\"{role}\"}} {int(payload is not None)}")
        # -1, not 0, for "unknown": 0 is the value a perfectly healthy process
        # reports, and a missing heartbeat must never render as the healthiest
        # possible reading.
        shown = age if age is not None else -1
        if role == "worker":
            lines.append(f"workflow_worker_consuming {alive}")
            lines.append(f"workflow_worker_last_task_age_sec {shown}")
            lines.append(f"workflow_worker_tasks_total {(payload or {}).get('events_total', 0)}")
            lines.append(
                f"workflow_worker_task_failures_total {(payload or {}).get('failures_total', 0)}"
            )
        else:
            lines.append(f"workflow_beat_publishing {alive}")
            lines.append(f"workflow_beat_last_publish_age_sec {shown}")
    return "\n".join(lines)


# ── the worker / beat processes' view ────────────────────────────────────────


class ProcessProbeServer:
    """A stdlib HTTP server on a daemon thread, serving one process's heartbeat.

    Runs inside the Celery worker and beat, which have no web framework and should
    not grow one for this. It shares NOTHING with the task pool — no event loop, no
    ORM session, its own thread — because it has to keep answering while the thing
    it reports on is wedged, and a probe wired through the machinery it is watching
    goes down with it.

    The two short Redis reads on the /readyz path are the only outbound calls, and
    both are allowed to fail into a NAMED reason rather than an exception: a broker
    it cannot read is not an error to report, it is the finding.
    """

    def __init__(self, role: str, *, port: int, silence_limit: float) -> None:
        self.role = role
        self.port = port
        self.silence_limit = silence_limit
        self.started_at = time.time()
        self._srv: ThreadingHTTPServer | None = None

    def state(self) -> tuple[dict | None, str | None, float | None]:
        """(own heartbeat, read error, age). Read from Redis, not from memory.

        The counters cannot live in this process: Celery's prefork pool runs
        ``task_postrun`` in a forked CHILD, so an in-process counter is invisible
        to this thread and separately wrong in each of the eleven children.
        """
        payload, err = heartbeat.read_sync(self.role)
        return payload, err, heartbeat.age_of(payload)

    # The one place a worker/beat readiness verdict is computed.
    def reasons(self) -> tuple[list[str], dict]:
        own, err, age = self.state()
        peer_role = "beat" if self.role == "worker" else "worker"
        peer, peer_err = heartbeat.read_sync(peer_role)
        peer_age = heartbeat.age_of(peer)
        ctx = {
            "own": own, "own_age_sec": age, "read_error": err,
            "peer_role": peer_role, "peer_age_sec": peer_age, "peer_read_error": peer_err,
        }
        if err is not None:
            # The broker being unreachable is not a symptom of the worker: it is
            # the cause, and it means the worker is not receiving tasks either.
            # Named as the broker so nobody goes reading the worker's task log.
            return ([f"{self.role}: celery broker unreachable, so neither tasks nor this "
                     f"heartbeat can move: {err}"], ctx)
        if age is None:
            return ([f"{self.role}: no heartbeat has been recorded since boot — the probe "
                     f"armed but no Celery signal has fired"], ctx)
        if age < self.silence_limit:
            return ([], ctx)

        if self.role == "beat":
            return ([f"beat: nothing published for {age}s (limit {self.silence_limit}s); the "
                     f"schedule publishes twice a minute, so this is not an idle period"], ctx)

        # A worker that has completed nothing because beat stopped SENDING is a
        # healthy worker with a dead upstream. Quoting beat's age here is what
        # makes the reason name the right CONTAINER instead of this one.
        if peer_age is None:
            blame = ("beat's heartbeat cannot be read at all (beat is down, or it never "
                     "armed) — nothing is being SENT, so having nothing to do is expected "
                     "here: look at workflow-beat")
        elif peer_age >= heartbeat.BEAT_SILENCE_SEC:
            blame = (f"beat last published {peer_age}s ago, so nothing is being SENT: look "
                     f"at workflow-beat, not at this container")
        else:
            blame = (f"beat published {peer_age}s ago, so tasks ARE being sent and this "
                     f"worker is not executing them — the task queue is not being consumed")
        return ([f"worker: no task completed for {age}s (limit {self.silence_limit}s); "
                 f"{blame}"], ctx)

    def payload(self) -> tuple[bool, dict]:
        reasons, ctx = self.reasons()
        own = ctx["own"] or {}
        return not reasons, {
            "ready": not reasons,
            "reasons": reasons,
            "service": "workflow",
            "role": self.role,
            "uptime_sec": round(time.time() - self.started_at, 1),
            "age_sec": ctx["own_age_sec"],
            "silence_limit_sec": self.silence_limit,
            "last_event_name": own.get("last_event_name"),
            "events_total": own.get("events_total"),
            "failures_total": own.get("failures_total"),
            "last_error": own.get("last_error"),
            "broker_read_error": ctx["read_error"],
            "peer": {"role": ctx["peer_role"], "age_sec": ctx["peer_age_sec"],
                     "read_error": ctx["peer_read_error"]},
        }

    def prometheus(self) -> str:
        r = self.role
        own, err, age = self.state()
        own = own or {}
        alive = int(age is not None and age < self.silence_limit)
        verb = "completed" if r == "worker" else "published"
        return "\n".join([
            f"# HELP workflow_{r}_process_up 1 while the process is running. LIVENESS ONLY — "
            f"it is the number that stayed at 1 through every wedge this file exists for.",
            f"# TYPE workflow_{r}_process_up gauge",
            f"workflow_{r}_process_up 1",
            f"# HELP workflow_{r}_uptime_sec Seconds since this container's probe armed.",
            f"# TYPE workflow_{r}_uptime_sec gauge",
            f"workflow_{r}_uptime_sec {round(time.time() - self.started_at, 1)}",
            f"# HELP workflow_{r}_event_age_sec Seconds since a task was last {verb}. "
            f"-1 means the broker could not be read, which is itself a wedge: no tasks are "
            f"moving either.",
            f"# TYPE workflow_{r}_event_age_sec gauge",
            f"workflow_{r}_event_age_sec {age if age is not None else -1}",
            f"# HELP workflow_{r}_alive 1 while a task was {verb} within the silence limit "
            f"({self.silence_limit}s). NOT a traffic gauge: the beat schedule publishes two "
            f"sweeps a minute forever, so an estate with zero incidents still reads 1.",
            f"# TYPE workflow_{r}_alive gauge",
            f"workflow_{r}_alive {alive}",
            f"# HELP workflow_{r}_events_total Tasks {verb} since this process armed.",
            f"# TYPE workflow_{r}_events_total counter",
            f"workflow_{r}_events_total {own.get('events_total', 0)}",
            f"# HELP workflow_{r}_failures_total Tasks that ended in FAILURE. Separate from "
            f"the liveness count on purpose: a failing task still proves the worker is "
            f"consuming, and the two need opposite responses.",
            f"# TYPE workflow_{r}_failures_total counter",
            f"workflow_{r}_failures_total {own.get('failures_total', 0)}",
            f"# HELP workflow_{r}_broker_readable 1 when this probe could read its heartbeat "
            f"back off Redis.",
            f"# TYPE workflow_{r}_broker_readable gauge",
            f"workflow_{r}_broker_readable {int(err is None)}",
            "",
        ])

    def start(self) -> None:
        probe = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, code: int, body: str, ctype: str) -> None:
                raw = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler's contract
                path = self.path.split("?")[0]
                if path == "/health":
                    # Liveness. Touches nothing. If this thread can answer, the
                    # process is running its own code — that is the entire claim.
                    self._send(200, json.dumps(
                        {"status": "ok", "service": "workflow", "role": probe.role}
                    ), "application/json")
                elif path == "/readyz":
                    # The two Redis reads here are the only outbound calls on this
                    # path, and both are allowed to fail: reasons() turns an
                    # unreadable broker into a NAMED reason rather than an
                    # exception, so the probe keeps answering through the outage
                    # it is reporting.
                    ok, body = probe.payload()
                    self._send(200 if ok else 503, json.dumps(body), "application/json")
                elif path == "/metrics":
                    self._send(200, probe.prometheus(), "text/plain; version=0.0.4")
                else:
                    self._send(404, "not found\n", "text/plain")

            def log_message(self, *args):
                pass  # a healthcheck every 15s must not drown the task log

        self._srv = ThreadingHTTPServer(("0.0.0.0", self.port), Handler)
        threading.Thread(
            target=self._srv.serve_forever, name=f"probe-http-{self.role}", daemon=True
        ).start()
        log.info("probe server listening on :%s (role=%s)", self.port, self.role)
