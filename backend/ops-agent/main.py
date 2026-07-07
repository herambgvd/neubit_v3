"""Neubit v3 ops-agent — the privileged infrastructure-control sidecar.

WHY THIS EXISTS
    Super-admins need to see and control the compose stack (list containers, tail
    logs, restart/stop/start services, scale stateless workers) from the platform
    UI. Doing that means talking to the Docker daemon — which is root-equivalent.
    We DO NOT want that power inside the core API (it's internet-facing behind
    Traefik and runs tenant code paths). So we isolate it here:

      * This is the ONLY service that mounts /var/run/docker.sock.
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

import os

import docker
from docker.errors import APIError, NotFound
from fastapi import Depends, FastAPI, Header, HTTPException, Path
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
async def require_token(x_ops_token: str | None = Header(default=None)) -> None:
    """Fail closed: 401 unless the header exactly matches the configured token.

    If OPS_AGENT_TOKEN is unset we reject everything — an unauthenticated
    docker-control endpoint must never be reachable.
    """
    if not OPS_AGENT_TOKEN or x_ops_token != OPS_AGENT_TOKEN:
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
    """Unauthenticated liveness probe (no docker access, no secrets)."""
    return {"ok": True, "service": "ops-agent", "project": COMPOSE_PROJECT}


@app.get("/containers", dependencies=[Depends(require_token)])
async def list_containers() -> list[dict]:
    """Every container in the neubit-v3 compose project, with live cpu/mem stats."""
    client = get_docker()
    return [_serialize(c) for c in _project_containers(client)]


class LogsOut(BaseModel):
    lines: list[str]


@app.get("/containers/{name}/logs", dependencies=[Depends(require_token)])
async def container_logs(name: str = Path(...), tail: int = 200) -> LogsOut:
    """Tail the last `tail` log lines of a project container (raw, newest-last)."""
    tail = max(1, min(int(tail), 5000))  # clamp — don't let a caller pull GBs
    client = get_docker()
    container = _get_project_container(client, name)
    try:
        raw = container.logs(tail=tail, timestamps=True)
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
        raise HTTPException(status_code=502, detail=f"docker {verb} failed: {exc}") from exc
    return OkOut(ok=True)


@app.post("/containers/{name}/restart", dependencies=[Depends(require_token)])
async def restart_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "restart")


@app.post("/containers/{name}/stop", dependencies=[Depends(require_token)])
async def stop_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "stop")


@app.post("/containers/{name}/start", dependencies=[Depends(require_token)])
async def start_container(name: str = Path(...)) -> OkOut:
    return _lifecycle(name, "start")


class ScaleIn(BaseModel):
    replicas: int


@app.post("/services/{name}/scale", dependencies=[Depends(require_token)])
async def scale_service(name: str = Path(...), body: ScaleIn | None = None) -> OkOut:
    """Best-effort horizontal scale of a compose *service* by cloning replicas.

    CAVEAT (read carefully):
        Safely reproducing a container's full config (env, mounts, networks,
        healthcheck, labels, command) to spin up extra replicas is only sound for
        STATELESS worker services. Stateful services (postgres, redis, nats, the
        core API bound to :8000, the gateway) MUST NOT be naively cloned — doing
        so causes port clashes and data corruption.

        neubit-v3 does not yet have media/ingest worker services to scale, so
        rather than risk cloning a stateful service, we DO NOT attempt a clone
        here. We return ok=false with an explanatory detail. This endpoint is a
        stable placeholder: when real stateless workers exist (e.g. an
        ingest-worker or media-transcode-worker), wire the clone logic here
        (docker SDK: read the template container's HostConfig + NetworkingConfig +
        Env, then containers.run(..., name=f"{project}-{service}-{n}") for the
        delta, or `container.remove()` down to `replicas`). Guard it to a known
        allow-list of stateless service names.

    The endpoint intentionally NEVER crashes on an unsupported service.
    """
    replicas = body.replicas if body else 0
    return OkOut(
        ok=False,
        detail=(
            f"scaling requested for service {name!r} -> {replicas} replicas, but "
            "scaling applies to stateless worker services; wire when media/ingest "
            "workers exist"
        ),
    )


@app.get("/host", dependencies=[Depends(require_token)])
async def host_summary() -> dict:
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
        vm = psutil.virtual_memory()
        out["mem_used_mb"] = round(vm.used / (1024 * 1024), 1)
        out["mem_total_mb"] = round(vm.total / (1024 * 1024), 1)
        disk = psutil.disk_usage("/")
        out["disk_used_gb"] = round(disk.used / (1024**3), 1)
        out["disk_total_gb"] = round(disk.total / (1024**3), 1)
    except Exception:  # noqa: BLE001 — host stats are best-effort, never fatal
        pass
    return out
