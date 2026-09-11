"""Neubit v3 ops-agent — the privileged infrastructure-control sidecar.

WHY THIS EXISTS
    Super-admins need to see and control the compose stack (list containers, tail
    logs, restart/stop/start services, scale stateless workers) from the platform
    UI. Doing that means talking to the Docker daemon — which is root-equivalent.
    We DO NOT want that power inside the core API (it's internet-facing behind
    Traefik and runs tenant code paths). So we isolate it here:

      * It is the only service that mounts /var/run/docker.sock. (The gateway
        used to mount it too, unused, while claiming otherwise here.)
      * It has NO host port and NO Traefik labels — it is reachable only from the
        internal `neubit` docker network (i.e. from `core`).
      * Every request must carry header  X-Ops-Token == env OPS_AGENT_TOKEN, else 401.
      * It refuses to act on any container that is NOT part of the neubit-v3
        compose project (whitelist by the compose project label). It can never be
        tricked into touching an arbitrary host container.

    The `core` service proxies super-admin requests here (see
    app/infra/ in core), adding the token and its own require_superadmin gate.
"""

from __future__ import annotations

import hmac
import io
from concurrent.futures import ThreadPoolExecutor
import logging
import os
import re
import tarfile
import uuid

import docker
from docker.errors import APIError, NotFound
from fastapi import Depends, FastAPI, Header, HTTPException, Path, Request, Response
from pydantic import BaseModel

# --- Configuration -----------------------------------------------------------
# The shared secret every caller must present. Empty means "unset" -> we fail
# closed (all requests 401) rather than fail open.
OPS_AGENT_TOKEN = os.getenv("OPS_AGENT_TOKEN", "")

# The compose project this agent is allowed to manage. Containers outside this
# project are invisible AND untouchable. We match on the standard compose label
# `com.docker.compose.project`. As a fallback (e.g. containers started outside
# compose) we also accept names that begin with `<project>-`.
COMPOSE_PROJECT = os.getenv("COMPOSE_PROJECT", "neubit-v3")
_COMPOSE_LABEL = "com.docker.compose.project"
_COMPOSE_SERVICE_LABEL = "com.docker.compose.service"

# Database backup/restore config. The agent execs pg_dump/psql *inside* the
# postgres container (no pg client needed in this image), scoped to the control DB.
DB_SERVICE = os.getenv("DB_SERVICE", "postgres")
DB_USER = os.getenv("POSTGRES_USER", "neubit")
DB_NAME = os.getenv("POSTGRES_DB", "neubit_control")
DB_PASSWORD = os.getenv("POSTGRES_PASSWORD", "")

logging.basicConfig(
    level=os.getenv("VE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("ops-agent")

#: Cap on an uploaded SQL dump. The agent is the most privileged container in the
#: stack; letting one request decide its memory use is not a trade worth making.
MAX_DUMP_BYTES = int(os.getenv("OPS_AGENT_MAX_DUMP_BYTES", 512 * 1024 * 1024))

app = FastAPI(title="neubit-ops-agent", docs_url=None, redoc_url=None)

# One shared Docker client for the process, created lazily so the app can import
# (and be syntax-checked / unit-tested) without a live socket.
_client: docker.DockerClient | None = None


def get_docker() -> docker.DockerClient:
    global _client
    if _client is None:
        # from_env() honours DOCKER_HOST; default is unix:///var/run/docker.sock,
        # which is exactly what we mount.
        _client = docker.from_env()
    return _client


# --- Auth --------------------------------------------------------------------
async def require_token(
    request: Request, x_ops_token: str | None = Header(default=None)
) -> None:
    """Fail closed: 401 unless the header matches the configured token.

    An unset token rejects everything — an unauthenticated docker-control endpoint
    must never be reachable.

    Compared with compare_digest, and every refusal is logged with the peer. There
    was no record of a failed attempt at all, so an online guessing loop against
    the most privileged container in the stack was invisible.
    """
    ok = bool(OPS_AGENT_TOKEN) and hmac.compare_digest(x_ops_token or "", OPS_AGENT_TOKEN)
    if not ok:
        peer = request.client.host if request.client else "?"
        log.warning(
            "refused %s %s from %s (%s)",
            request.method, request.url.path, peer,
            "token not configured" if not OPS_AGENT_TOKEN else "bad token",
        )
        raise HTTPException(status_code=401, detail="invalid or missing X-Ops-Token")


# --- Project whitelist helpers ----------------------------------------------
def _in_project(container) -> bool:
    """True iff the container belongs to our compose project (or name-prefixed)."""
    labels = container.labels or {}
    if labels.get(_COMPOSE_LABEL) == COMPOSE_PROJECT:
        return True
    # Fallback for containers not started by compose but named like the project.
    return (container.name or "").startswith(f"{COMPOSE_PROJECT}-")


def _get_project_container(client: docker.DockerClient, name: str):
    """Fetch a container by name, but ONLY if it's in our project. Else 404.

    We never surface (or act on) containers outside the whitelist — from the
    caller's point of view they simply do not exist.
    """
    try:
        container = client.containers.get(name)
    except NotFound:
        raise HTTPException(status_code=404, detail=f"container {name!r} not found")
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"docker error: {exc}") from exc
    if not _in_project(container):
        # Do not distinguish "outside project" from "missing" — avoids leaking
        # the existence of unrelated host containers.
        raise HTTPException(status_code=404, detail=f"container {name!r} not found")
    return container


def _project_containers(client: docker.DockerClient):
    """All containers (running + stopped) that belong to our compose project."""
    try:
        containers = client.containers.list(
            all=True, filters={"label": f"{_COMPOSE_LABEL}={COMPOSE_PROJECT}"}
        )
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"docker error: {exc}") from exc
    # Belt-and-suspenders: re-filter through _in_project in case the daemon
    # returned something unexpected.
    return [c for c in containers if _in_project(c)]


def _service_container(client: docker.DockerClient, service: str):
    """The in-project container for a compose service name (e.g. 'postgres')."""
    for c in _project_containers(client):
        if (c.labels or {}).get(_COMPOSE_SERVICE_LABEL) == service:
            return c
    raise HTTPException(status_code=404, detail=f"service {service!r} not found")


# --- Stats helpers -----------------------------------------------------------
def _cpu_percent(stats: dict) -> float | None:
    """Compute CPU % from a single (non-streaming) stats sample.

    docker's `docker stats` uses the delta between two reads; a one-shot
    stats(stream=False) sample already contains both `cpu_stats` (current) and
    `precpu_stats` (previous) so we can derive it in one call.
    """
    try:
        cpu = stats["cpu_stats"]
        precpu = stats["precpu_stats"]
        cpu_delta = cpu["cpu_usage"]["total_usage"] - precpu["cpu_usage"]["total_usage"]
        system_delta = cpu["system_cpu_usage"] - precpu.get("system_cpu_usage", 0)
        online = cpu.get("online_cpus") or len(
            cpu["cpu_usage"].get("percpu_usage") or [1]
        )
        if system_delta > 0 and cpu_delta >= 0:
            return round((cpu_delta / system_delta) * online * 100.0, 2)
    except (KeyError, TypeError, ZeroDivisionError):
        return None
    return None


def _mem(stats: dict) -> tuple[float | None, float | None]:
    """Return (used_mb, limit_mb) from a stats sample."""
    try:
        mem = stats["memory_stats"]
        usage = mem.get("usage")
        # cache is counted in usage on cgroup v1; subtract it for a truer RSS.
        cache = (mem.get("stats") or {}).get("cache", 0)
        limit = mem.get("limit")
        used_mb = round((usage - cache) / (1024 * 1024), 1) if usage is not None else None
        limit_mb = round(limit / (1024 * 1024), 1) if limit else None
        return used_mb, limit_mb
    except (KeyError, TypeError):
        return None, None


def _health(container) -> str | None:
    """The container's healthcheck status ('healthy'/'unhealthy'/'starting'), or None."""
    try:
        return (container.attrs.get("State", {}).get("Health", {}) or {}).get("Status")
    except (KeyError, AttributeError):
        return None


def _serialize(container, *, with_stats: bool = True) -> dict:
    image = ""
    try:
        tags = container.image.tags
        image = tags[0] if tags else (container.image.short_id or "")
    except (APIError, AttributeError):
        image = ""

    cpu_pct = mem_used = mem_limit = None
    if with_stats and container.status == "running":
        try:
            stats = container.stats(stream=False)
            cpu_pct = _cpu_percent(stats)
            mem_used, mem_limit = _mem(stats)
        except (APIError, KeyError, TypeError):
            pass

    return {
        "name": container.name,
        "id": container.short_id,
        "image": image,
        "state": container.status,  # created|running|paused|restarting|exited|dead
        "status": container.attrs.get("State", {}).get("Status", container.status),
        "health": _health(container),
        "created_at": container.attrs.get("Created"),
        "service": (container.labels or {}).get(_COMPOSE_SERVICE_LABEL),
        "cpu_pct": cpu_pct,
        "mem_used_mb": mem_used,
        "mem_limit_mb": mem_limit,
    }


# --- Endpoints ---------------------------------------------------------------
@app.get("/health")
async def health() -> dict:
    """Liveness: the process is up. Touches nothing, so it cannot fail for a
    dependency outage — restarting would not fix one."""
    return {"ok": True, "service": "ops-agent"}


@app.get("/readyz")
def readyz() -> Response:
    """Readiness: can this agent actually reach the docker daemon?

    The agent's whole purpose is the socket. Without this the container reported
    running while every request 502'd. A plain `def` — daemon calls block.

    Unauthenticated, like /health, and it returns only up/down: an orchestrator
    has no token, and the answer says nothing a caller could not learn by being
    refused.
    """
    import json

    try:
        get_docker().ping()
    except Exception as exc:  # noqa: BLE001 — any failure is "not ready"
        log.warning("readiness: docker daemon unreachable: %s", exc)
        return Response(
            content=json.dumps({"status": "not_ready", "checks": {"docker": "unreachable"}}),
            status_code=503,
            media_type="application/json",
        )
    return Response(
        content=json.dumps({"status": "ok", "checks": {"docker": "ok"}}),
        status_code=200,
        media_type="application/json",
    )


@app.get("/containers", dependencies=[Depends(require_token)])
def list_containers() -> list[dict]:
    """Every container in the compose project, with live cpu/mem stats.

    Two things had to change for this to work at all.

    It is a plain `def`, so FastAPI runs it in a threadpool. As `async def` the
    docker SDK's blocking calls ran ON the event loop, so for the duration nothing
    else the agent served could make progress — including /health and any restart.

    And the per-container stats calls run concurrently. Each takes ~1.5s (the
    daemon samples twice), so sequentially 20 containers measured 35.3s against
    core's 30s client timeout: a super-admin's container list always failed.
    """
    client = get_docker()
    containers = _project_containers(client)
    if not containers:
        return []
    # One thread per container, capped. These are all waiting on the daemon, not
    # burning CPU, so the cap is about not opening 200 sockets at once.
    with ThreadPoolExecutor(max_workers=min(len(containers), 16)) as pool:
        return list(pool.map(_serialize, containers))


class LogsOut(BaseModel):
    lines: list[str]


@app.get("/containers/{name}/logs", dependencies=[Depends(require_token)])
def container_logs(name: str = Path(...), tail: int = 200, since: int = 0) -> LogsOut:
    """Tail the last `tail` log lines of a project container (raw, newest-last).

    ``since`` is a unix timestamp: only lines written after it are returned. A
    live viewer polls with the timestamp of the last line it holds, so a follow
    costs the NEW lines instead of re-fetching the whole tail every few seconds.
    Zero means "no lower bound" and behaves exactly as before.
    """
    tail = max(1, min(int(tail), 5000))  # clamp — don't let a caller pull GBs
    client = get_docker()
    container = _get_project_container(client, name)
    try:
        raw = container.logs(tail=tail, timestamps=True, since=int(since) or None)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"docker error: {exc}") from exc
    text = raw.decode("utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return LogsOut(lines=lines)


class OkOut(BaseModel):
    ok: bool
    detail: str | None = None


def _lifecycle(name: str, verb: str) -> OkOut:
    """Shared restart/stop/start implementation (whitelisted, error-mapped)."""
    client = get_docker()
    container = _get_project_container(client, name)
    try:
        getattr(container, verb)()
    except APIError as exc:
        log.error("%s %s failed: %s", verb, name, exc)
        raise HTTPException(status_code=502, detail=f"docker {verb} failed: {exc}") from exc
    # The agent had no record of its own actions. Core audits its side, but core
    # is not the only caller that can reach this port.
    log.info("%s %s", verb, name)
    return OkOut(ok=True)


@app.post("/containers/{name}/restart", dependencies=[Depends(require_token)])
def restart_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "restart")


@app.post("/containers/{name}/stop", dependencies=[Depends(require_token)])
def stop_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "stop")


@app.post("/containers/{name}/start", dependencies=[Depends(require_token)])
def start_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "start")


class ScaleIn(BaseModel):
    replicas: int


@app.post("/services/{name}/scale", dependencies=[Depends(require_token)])
async def scale_service(name: str = Path(...), body: ScaleIn | None = None) -> OkOut:
    """Not implemented — 501.

    It used to return 200 with ok=false, so core audit-logged `infra.service.scale`
    as though something had happened. A 501 says the same thing in the one place a
    caller cannot ignore.

    Cloning a container's full config is only sound for stateless workers; doing it
    to postgres, redis, nats or the API means port clashes and data corruption.
    There are no stateless workers to scale yet. When there are, guard it with an
    allow-list of service names.
    """
    raise HTTPException(
        status_code=501,
        detail=f"scaling {name!r} is not implemented — no stateless worker services yet",
    )


@app.get("/host", dependencies=[Depends(require_token)])
def host_summary() -> dict:
    """Host/stack summary: project container counts (+ optional host cpu/mem/disk)."""
    client = get_docker()
    containers = _project_containers(client)
    running = sum(1 for c in containers if c.status == "running")
    out: dict = {
        "containers_running": running,
        "containers_total": len(containers),
    }
    # psutil is optional — include host stats when available, never fail without it.
    try:
        import psutil

        out["cpu_pct"] = psutil.cpu_percent(interval=None)
        out["cpu_count"] = psutil.cpu_count(logical=True)
        vm = psutil.virtual_memory()
        out["mem_used_mb"] = round(vm.used / (1024 * 1024), 1)
        out["mem_total_mb"] = round(vm.total / (1024 * 1024), 1)
        disk = psutil.disk_usage("/")
        out["disk_used_gb"] = round(disk.used / (1024**3), 1)
        out["disk_total_gb"] = round(disk.total / (1024**3), 1)
    except Exception:  # noqa: BLE001 — host stats are best-effort, never fatal
        pass
    return out


# --- database backup / restore ----------------------------------------------
def _pg_env() -> dict[str, str]:
    return {"PGPASSWORD": DB_PASSWORD} if DB_PASSWORD else {}


# Lines a pg_dump emits that must be rewritten before replaying into the LIVE
# database. The extension is already installed and cannot be dropped while in use;
# pg_dump's timeout=0 would let a DROP hang forever behind an app-held lock.
_TS_EXT_RE = re.compile(r"^\s*(DROP|CREATE)\s+EXTENSION.*timescaledb", re.IGNORECASE)
_TS_COMMENT_RE = re.compile(r"^\s*COMMENT\s+ON\s+EXTENSION\s+timescaledb", re.IGNORECASE)

# psql meta-commands pg_dump legitimately emits. Anything else is refused.
#
# This matters more than it looks: `psql -f` executes meta-commands, and a shell
# escape runs
# a command inside the postgres container — the one holding pgdata. So this
# endpoint's real capability was "run anything as root in the database container",
# not "restore a backup". Verified against the live container.
#
# `\.` terminates a COPY block and appears ~56 times in a real dump. `\restrict`
# and `\unrestrict` appear on PG 17+. `\connect` appears in some dump modes.
_ALLOWED_META = {"\\.", "\\restrict", "\\unrestrict", "\\connect"}

_COPY_START_RE = re.compile(r"^\s*COPY\s.+\sFROM\s+stdin;", re.IGNORECASE)


def _meta_command(line: str) -> str | None:
    """The meta-command a line invokes, or None if it is not one."""
    stripped = line.lstrip()
    if not stripped.startswith("\\"):
        return None
    return stripped.split(None, 1)[0].rstrip("\n")


def _sanitize_dump(sql: bytes) -> bytes:
    r"""Make a plain pg_dump safe to replay, or refuse it.

    Refuses rather than strips an unexpected meta-command. Quietly editing what
    someone believes they are restoring is its own problem, and a dump containing
    `\!` is not a dump.
    """
    text = sql.decode("utf-8", "replace")
    out: list[str] = []
    in_copy = False

    for lineno, line in enumerate(text.splitlines(keepends=True), 1):
        if in_copy:
            # COPY data. A line here can begin with anything; only `\.` ends the
            # block, so nothing inside it is a meta-command.
            out.append(line)
            if line.rstrip("\r\n") == "\\.":
                in_copy = False
            continue

        meta = _meta_command(line)
        if meta is not None and meta not in _ALLOWED_META:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"refusing dump: psql meta-command {meta!r} on line {lineno}. "
                    "Only pg_dump's own meta-commands are accepted."
                ),
            )

        if _TS_EXT_RE.match(line) or _TS_COMMENT_RE.match(line):
            continue
        stripped = line.strip()
        if stripped == "SET lock_timeout = 0;":
            out.append("SET lock_timeout = '120s';\n")
        elif stripped == "SET statement_timeout = 0;":
            out.append("SET statement_timeout = '300s';\n")
        elif stripped.startswith("SET transaction_timeout"):
            continue  # unsupported on some server versions
        else:
            out.append(line)
            if _COPY_START_RE.match(line):
                in_copy = True

    return "".join(out).encode("utf-8")


async def _read_capped(request: Request) -> bytes:
    """Read the body in chunks, refusing it once it passes MAX_DUMP_BYTES.

    `await request.body()` read the whole thing first, and _sanitize_dump then held
    the text, the split lines and the joined result — three more copies. An
    uncapped POST could OOM the container that holds the docker socket.
    """
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_DUMP_BYTES:
        raise HTTPException(status_code=413, detail="SQL dump too large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_DUMP_BYTES:
            raise HTTPException(status_code=413, detail="SQL dump too large")
        chunks.append(chunk)
    return b"".join(chunks)


@app.get("/db/export", dependencies=[Depends(require_token)])
def db_export() -> Response:
    """Stream a plain-SQL dump of the control database (pg_dump inside postgres)."""
    client = get_docker()
    container = _service_container(client, DB_SERVICE)
    cmd = [
        "pg_dump", "-U", DB_USER, "-d", DB_NAME,
        "--clean", "--if-exists", "--no-owner", "--no-privileges",
    ]
    try:
        exit_code, streams = container.exec_run(cmd, environment=_pg_env(), demux=True)
    except APIError as exc:
        raise HTTPException(status_code=502, detail=f"docker error: {exc}") from exc
    stdout, stderr = streams if isinstance(streams, tuple) else (streams, b"")
    if exit_code != 0:
        msg = (stderr or b"").decode("utf-8", "replace")[:500]
        raise HTTPException(status_code=502, detail=f"pg_dump failed: {msg}")
    return Response(content=stdout or b"", media_type="application/sql")


@app.post("/db/import", dependencies=[Depends(require_token)])
async def db_import(request: Request) -> dict:
    """Restore the control database from a plain-SQL dump (psql inside postgres).

    The SQL is written into the container and applied with ON_ERROR_STOP so a bad
    statement aborts the whole restore instead of leaving a half-applied DB.
    """
    sql = await _read_capped(request)
    if not sql:
        raise HTTPException(status_code=400, detail="empty SQL body")

    sql = _sanitize_dump(sql)

    client = get_docker()
    container = _service_container(client, DB_SERVICE)

    # A unique name, not a fixed one. The old path was predictable and the file
    # was never removed, so a full control-DB dump — password hashes, encrypted
    # tenant secrets, the audit log — sat in the postgres container readable by
    # anything that could exec in, until the container was recreated. Two
    # concurrent restores also interleaved into the same file.
    # A PRIVATE DIRECTORY, not a file in the shared one.
    #
    # /tmp is world-writable, and both halves of that matter. World-READABLE means
    # a full control-DB dump — password hashes, encrypted tenant secrets, the audit
    # log — is visible to anything that can exec into the container for as long as
    # it exists. World-WRITABLE means another process can pre-create the path and
    # have us write through its symlink.
    #
    # So the dump goes inside a 0700 directory with an unpredictable name, created
    # in the same archive: the directory is ours before the file exists, nobody
    # else can enter it, and the tar carries both modes so there is no window
    # between creating and locking them down. The file itself is 0600 as well —
    # belt and braces, because the two protect against different mistakes.
    stage = f"neubit_restore_{uuid.uuid4().hex}"
    path = f"/tmp/{stage}/dump.sql"
    tar_buf = io.BytesIO()
    with tarfile.open(fileobj=tar_buf, mode="w") as tar:
        d = tarfile.TarInfo(name=stage)
        d.type = tarfile.DIRTYPE
        d.mode = 0o700
        tar.addfile(d)
        info = tarfile.TarInfo(name=f"{stage}/dump.sql")
        info.size = len(sql)
        info.mode = 0o600
        tar.addfile(info, io.BytesIO(sql))
    tar_buf.seek(0)
    try:
        if not container.put_archive("/tmp", tar_buf.getvalue()):
            raise HTTPException(status_code=502, detail="failed to stage SQL in container")

        # Apply the dump atomically: --single-transaction means any failure rolls
        # back the WHOLE restore, so a partial/interrupted run can never leave the
        # DB half-dropped. lock_timeout/statement_timeout fail fast instead of
        # hanging forever if a lock can't be acquired (e.g. the live app is busy).
        # We deliberately do NOT terminate other connections — doing so would kill
        # core's own pool mid-request. Idle connections don't hold table locks, so
        # the restore usually proceeds; under contention it fails cleanly.
        # --single-transaction: the whole restore is atomic, so any failure (or the
        # lock_timeout baked into the sanitized dump firing) rolls everything back —
        # the DB is never left half-restored. The dump's own SET lock_timeout='120s'
        # makes DROPs wait for a lock gap instead of failing instantly.
        exit_code, streams = container.exec_run(
            [
                "psql", "-U", DB_USER, "-d", DB_NAME, "-X",
                "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", path,
            ],
            environment=_pg_env(),
            demux=True,
        )
    except APIError as exc:
        log.error("db import failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"docker error: {exc}") from exc
    finally:
        # Always, including on failure — the staged file holds the whole dump.
        try:
            container.exec_run(["rm", "-rf", f"/tmp/{stage}"])
        except APIError as exc:  # noqa: BLE001 — cleanup must not mask the result
            log.warning("could not remove staged dump %s: %s", path, exc)
    stdout, stderr = streams if isinstance(streams, tuple) else (streams, b"")
    tail = ((stderr or b"") + (stdout or b""))[-2000:].decode("utf-8", "replace")
    log.info("db import finished exit=%s bytes=%d", exit_code, len(sql))
    return {"ok": exit_code == 0, "exit_code": exit_code, "output": tail}
