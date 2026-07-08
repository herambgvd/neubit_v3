"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Cpu,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ServerCog,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";

const CONTAINERS_REFETCH_MS = 4000;
const LOGS_REFETCH_MS = 3000;
const TAIL_OPTIONS = [200, 500, 1000];

// ── helpers ────────────────────────────────────────────────────────────────
function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

function uptime(createdAt) {
  if (!createdAt) return "—";
  const start = new Date(createdAt).getTime();
  if (Number.isNaN(start)) return "—";
  let secs = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const d = Math.floor(secs / 86400);
  secs -= d * 86400;
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Number(v).toFixed(1)}%`;
}

function fmtMem(used, limit) {
  if (used == null && limit == null) return "—";
  const u = used != null ? Math.round(Number(used)) : "?";
  const l = limit != null ? Math.round(Number(limit)) : "?";
  return `${u} / ${l} MB`;
}

// state + health → tone: running=emerald, exited/unhealthy=red, restarting=amber.
function stateTone(container) {
  const state = (container.state || "").toLowerCase();
  const health = (container.health || "").toLowerCase();
  if (state === "restarting" || state === "created" || state === "paused") return "amber";
  if (health === "unhealthy" || state === "exited" || state === "dead") return "red";
  if (state === "running") return health === "starting" ? "amber" : "emerald";
  return "slate";
}

const TONE_BADGE = {
  emerald: "border-emerald-400/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  amber: "border-amber-400/20 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  red: "border-red-400/20 bg-red-500/10 text-red-600 dark:text-red-300",
  slate: "border-card-border bg-card text-foreground",
};
const TONE_DOT = {
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  red: "bg-red-400",
  slate: "bg-muted",
};

function StateBadge({ container }) {
  const tone = stateTone(container);
  const label = container.state
    ? container.state.charAt(0).toUpperCase() + container.state.slice(1)
    : "Unknown";
  const health = container.health;
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium " +
        TONE_BADGE[tone]
      }
    >
      <span className={"h-1.5 w-1.5 rounded-full " + TONE_DOT[tone]} />
      {label}
      {health && health !== "none" ? (
        <span className="text-[10px] opacity-70">· {health}</span>
      ) : null}
    </span>
  );
}

function MemBar({ used, limit }) {
  const u = Number(used);
  const l = Number(limit);
  const pct = l > 0 && !Number.isNaN(u) ? Math.min(100, Math.max(0, (u / l) * 100)) : 0;
  const tone = pct >= 90 ? "bg-red-400" : pct >= 70 ? "bg-amber-400" : "bg-cyan-400";
  return (
    <div className="min-w-[110px]">
      <div className="text-xs tabular-nums text-foreground">{fmtMem(used, limit)}</div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <div className={"h-full rounded-full transition-all " + tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── page ───────────────────────────────────────────────────────────────────
export default function InfrastructurePage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null); // container name for the log drawer
  const [busy, setBusy] = useState({}); // { [name]: "restart" | "stop" | "start" }

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["infra", "containers"],
    queryFn: () => adminApi.listContainers(),
    refetchInterval: CONTAINERS_REFETCH_MS,
  });

  // Host summary — optional; degrade gracefully if it 404s.
  const host = useQuery({
    queryKey: ["infra", "host"],
    queryFn: () => adminApi.infraHost(),
    refetchInterval: CONTAINERS_REFETCH_MS,
    retry: false,
  });

  const containers = normalize(data);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return containers;
    return containers.filter(
      (c) =>
        (c.name || "").toLowerCase().includes(needle) ||
        (c.image || "").toLowerCase().includes(needle)
    );
  }, [containers, q]);

  const runningCount = containers.filter((c) => (c.state || "").toLowerCase() === "running").length;
  const hostRunning = host.data?.containers_running ?? runningCount;
  const hostTotal = host.data?.containers_total ?? containers.length;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["infra", "containers"] });

  async function runAction(name, action) {
    setBusy((b) => ({ ...b, [name]: action }));
    try {
      if (action === "restart") await adminApi.restartContainer(name);
      else if (action === "stop") await adminApi.stopContainer(name);
      else if (action === "start") await adminApi.startContainer(name);
      toast.success(
        `${action === "restart" ? "Restarted" : action === "stop" ? "Stopped" : "Started"} ${name}`
      );
      invalidate();
    } catch (err) {
      toast.error(apiError(err, `Could not ${action} ${name}`));
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[name];
        return next;
      });
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Infrastructure</h1>
          <p className="mt-1 text-sm text-muted">
            Live container fleet on the host — state, resources, logs, and scaling.
          </p>
        </div>
        <ScaleControl />
      </div>

      {/* Host summary strip */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex items-center gap-2 rounded-lg border border-card-border bg-card px-3.5 py-2 text-sm">
          <Server className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
          <span className="text-muted">Containers</span>
          <span className="font-semibold tabular-nums text-foreground">
            {hostRunning}
            <span className="text-muted"> / {hostTotal}</span>
          </span>
          <span className="text-xs text-muted">running</span>
        </div>
        <div className="inline-flex items-center gap-2 rounded-lg border border-card-border bg-card px-3.5 py-2 text-sm text-muted">
          <Activity className={"h-4 w-4 " + (isFetching ? "animate-pulse text-emerald-600 dark:text-emerald-300" : "text-muted")} />
          Auto-refresh · 4s
        </div>
      </div>

      {/* Search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by name or image…"
            className="h-10 w-full rounded-lg border border-card-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-cyan-400/60 focus:ring-2 focus:ring-cyan-400/20"
          />
        </div>
      </div>

      {/* Containers table */}
      <div className="overflow-hidden rounded-2xl border border-card-border bg-card">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-card-border text-xs uppercase tracking-wide text-muted">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-5 py-3 font-medium">Image</th>
              <th className="px-5 py-3 font-medium">State</th>
              <th className="px-5 py-3 font-medium">CPU</th>
              <th className="px-5 py-3 font-medium">Memory</th>
              <th className="px-5 py-3 font-medium">Uptime</th>
              <th className="px-5 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <SkeletonRows />}

            {isError && (
              <tr>
                <td colSpan={7} className="px-5 py-10 text-center text-sm text-red-600 dark:text-red-300">
                  {apiError(error, "Failed to load containers")}
                </td>
              </tr>
            )}

            {!isLoading && !isError && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-5 py-16 text-center">
                  <div className="mx-auto flex max-w-xs flex-col items-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-card-border bg-card text-cyan-600 dark:text-cyan-300">
                      <Boxes className="h-5 w-5" />
                    </div>
                    <p className="mt-4 text-sm font-medium text-foreground">
                      {q ? "No matching containers" : "No containers found"}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {q ? "Try a different filter." : "The host reports no running containers."}
                    </p>
                  </div>
                </td>
              </tr>
            )}

            {!isLoading &&
              !isError &&
              filtered.map((c) => {
                const running = (c.state || "").toLowerCase() === "running";
                const rowBusy = busy[c.name];
                return (
                  <tr
                    key={c.id || c.name}
                    className="cursor-pointer border-b border-card-border last:border-0 transition hover:bg-hover"
                    onClick={() => setSelected(c.name)}
                  >
                    <td className="px-5 py-3.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(c.name);
                        }}
                        className="text-left font-medium text-foreground hover:text-cyan-600 dark:hover:text-cyan-300"
                      >
                        {c.name}
                      </button>
                      <div className="font-mono text-xs text-muted">
                        {(c.id || "").slice(0, 12)}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="font-mono text-xs text-muted">{c.image || "—"}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <StateBadge container={c} />
                    </td>
                    <td className="px-5 py-3.5 text-foreground">
                      <span className="inline-flex items-center gap-1.5 tabular-nums">
                        <Cpu className="h-3.5 w-3.5 text-muted" />
                        {fmtPct(c.cpu_pct)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <MemBar used={c.mem_used_mb} limit={c.mem_limit_mb} />
                    </td>
                    <td className="px-5 py-3.5 text-muted tabular-nums">{uptime(c.created_at)}</td>
                    <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <ActionButton
                          title="Restart"
                          tone="amber"
                          busy={rowBusy === "restart"}
                          disabled={!!rowBusy}
                          onClick={() => runAction(c.name, "restart")}
                          icon={RotateCcw}
                        />
                        {running ? (
                          <ActionButton
                            title="Stop"
                            tone="red"
                            busy={rowBusy === "stop"}
                            disabled={!!rowBusy}
                            onClick={() => {
                              if (window.confirm(`Stop container "${c.name}"?`)) {
                                runAction(c.name, "stop");
                              }
                            }}
                            icon={Square}
                          />
                        ) : (
                          <ActionButton
                            title="Start"
                            tone="emerald"
                            busy={rowBusy === "start"}
                            disabled={!!rowBusy}
                            onClick={() => runAction(c.name, "start")}
                            icon={Play}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 text-xs text-muted">
        {containers.length} container{containers.length === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </div>

      {selected && (
        <LogsDrawer name={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function ActionButton({ title, tone, icon: Icon, onClick, busy, disabled }) {
  const toneCls = {
    amber: "hover:border-amber-400/40 hover:text-amber-600 dark:hover:text-amber-300",
    red: "hover:border-red-400/40 hover:text-red-600 dark:hover:text-red-300",
    emerald: "hover:border-emerald-400/40 hover:text-emerald-600 dark:hover:text-emerald-300",
  }[tone];
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-card-border bg-card text-muted transition disabled:opacity-40 " +
        toneCls
      }
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
    </button>
  );
}

function SkeletonRows() {
  return Array.from({ length: 6 }).map((_, i) => (
    <tr key={i} className="border-b border-card-border last:border-0">
      {Array.from({ length: 7 }).map((__, j) => (
        <td key={j} className="px-5 py-4">
          <div className="h-3.5 w-full max-w-[120px] animate-pulse rounded bg-hover" />
        </td>
      ))}
    </tr>
  ));
}

// ── scale control ──────────────────────────────────────────────────────────
function ScaleControl() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [replicas, setReplicas] = useState(1);

  const scale = useMutation({
    mutationFn: () => adminApi.scaleService(name.trim(), Number(replicas)),
    onSuccess: (res) => {
      // ok:false with a detail is an informational outcome, not an error.
      if (res && res.ok === false) {
        toast.info(res.detail || "Scaling not applied for this service");
        return;
      }
      toast.success(`Scaled ${name.trim()} to ${replicas} replica${Number(replicas) === 1 ? "" : "s"}`);
      setOpen(false);
    },
    onError: (err) => toast.error(apiError(err, "Could not scale service")),
  });

  function submit(e) {
    e.preventDefault();
    if (scale.isPending) return;
    if (!name.trim()) {
      toast.error("Service name is required");
      return;
    }
    scale.mutate();
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-card-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition hover:border-muted hover:text-foreground"
      >
        <ServerCog className="h-4 w-4" />
        Scale service
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex shrink-0 items-center gap-2 rounded-lg border border-card-border bg-card p-1.5"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="service name"
        autoFocus
        className="h-8 w-36 rounded-md border border-card-border bg-card px-2.5 text-xs text-foreground placeholder:text-muted outline-none transition focus:border-cyan-400/60"
      />
      <input
        type="number"
        min={0}
        value={replicas}
        onChange={(e) => setReplicas(e.target.value)}
        className="h-8 w-16 rounded-md border border-card-border bg-card px-2.5 text-xs tabular-nums text-foreground outline-none transition focus:border-cyan-400/60"
      />
      <button
        type="submit"
        disabled={scale.isPending}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-semibold text-background transition hover:opacity-90 disabled:opacity-60"
      >
        {scale.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Scale
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="rounded-md p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
        aria-label="Cancel"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

// ── logs drawer ────────────────────────────────────────────────────────────
function lineTone(line) {
  const s = line.toUpperCase();
  if (/\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/.test(s)) return "text-red-600 dark:text-red-300";
  if (/\b(WARN|WARNING)\b/.test(s)) return "text-amber-600 dark:text-amber-300";
  if (/\b(INFO|DEBUG)\b/.test(s)) return "text-muted";
  return "text-foreground";
}

function LogsDrawer({ name, onClose }) {
  const [tail, setTail] = useState(200);
  const [auto, setAuto] = useState(true);
  const [filter, setFilter] = useState("");
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["infra", "logs", name, tail],
    queryFn: () => adminApi.containerLogs(name, tail),
    refetchInterval: auto ? LOGS_REFETCH_MS : false,
  });

  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((l) => l.toLowerCase().includes(needle));
  }, [lines, filter]);

  // Follow the tail when the user is already scrolled to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onScroll(e) {
    const el = e.currentTarget;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="animate-modal-in relative z-10 flex h-full w-full max-w-3xl flex-col border-l border-card-border bg-card shadow-2xl shadow-black/50">
        {/* header */}
        <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Boxes className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
              <span className="truncate font-mono">{name}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted">Tailing container logs</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* controls */}
        <div className="flex flex-wrap items-center gap-2 border-b border-card-border px-5 py-3">
          <div className="flex items-center gap-1 rounded-lg border border-card-border bg-card p-1">
            {TAIL_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setTail(n)}
                className={
                  "rounded-md px-2.5 py-1 text-xs font-medium transition " +
                  (tail === n ? "bg-hover text-foreground" : "text-muted hover:text-foreground")
                }
              >
                {n}
              </button>
            ))}
          </div>

          <button
            onClick={() => refetch()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-muted hover:text-foreground"
          >
            <RefreshCw className={"h-3.5 w-3.5 " + (isFetching ? "animate-spin" : "")} />
            Refresh
          </button>

          <button
            onClick={() => setAuto((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition " +
              (auto
                ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                : "border-card-border bg-card text-muted hover:text-foreground")
            }
          >
            {auto ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {auto ? "Live · 3s" : "Paused"}
          </button>

          <div className="relative min-w-[160px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter lines…"
              className="h-8 w-full rounded-lg border border-card-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted outline-none transition focus:border-cyan-400/60"
            />
          </div>
        </div>

        {/* log body */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-auto bg-black/40 px-4 py-3 font-mono text-xs leading-relaxed"
        >
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading logs…
            </div>
          ) : isError ? (
            <div className="flex h-full items-center justify-center text-red-600 dark:text-red-300">
              {apiError(error, "Failed to load logs")}
            </div>
          ) : shown.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted">
              {filter ? "No lines match the filter." : "No log output."}
            </div>
          ) : (
            shown.map((line, i) => (
              <div key={i} className={"whitespace-pre-wrap break-all " + lineTone(line)}>
                {line || " "}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-card-border px-5 py-2 text-[11px] text-muted">
          {shown.length} line{shown.length === 1 ? "" : "s"} shown
          {filter && lines.length !== shown.length ? ` · ${lines.length} total` : ""}
        </div>
      </div>
    </div>
  );
}
