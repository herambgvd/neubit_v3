"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Boxes,
  Cpu,
  Loader2,
  MemoryStick,
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
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  StatCard,
} from "@/components/ui";
import { Sparkline } from "@/components/charts";

const CONTAINERS_REFETCH_MS = 4000;
const LOGS_REFETCH_MS = 3000;
const TAIL_OPTIONS = [200, 500, 1000];
const HISTORY_LEN = 30;
// Utilisation thresholds (percent) for threshold-based tinting.
const WARN = 70;
const CRIT = 90;

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

// Adaptive memory unit: MB while small, GB once it crosses ~1 GB.
function fmtMB(mb) {
  if (mb == null || Number.isNaN(Number(mb))) return "?";
  const n = Number(mb);
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`;
}

function fmtMem(used, limit) {
  if (used == null && limit == null) return "—";
  return `${fmtMB(used)} / ${fmtMB(limit)}`;
}

function memPct(c) {
  const u = Number(c.mem_used_mb);
  const l = Number(c.mem_limit_mb);
  return l > 0 && !Number.isNaN(u) ? Math.min(100, Math.max(0, (u / l) * 100)) : 0;
}

// Threshold → semantic tone.
function utilTone(pct) {
  if (pct >= CRIT) return "danger";
  if (pct >= WARN) return "warning";
  return "accent";
}
const TONE_VAR = { danger: "var(--danger)", warning: "var(--warning)", accent: "var(--accent)", success: "var(--success)" };
const TONE_TEXT = { danger: "text-danger", warning: "text-warning", accent: "text-foreground", success: "text-success" };

// state + health → kit Badge tone.
function stateTone(container) {
  const state = (container.state || "").toLowerCase();
  const health = (container.health || "").toLowerCase();
  if (state === "restarting" || state === "created" || state === "paused") return "warning";
  if (health === "unhealthy" || state === "exited" || state === "dead") return "danger";
  if (state === "running") return health === "starting" ? "warning" : "success";
  return "neutral";
}

function StateBadge({ container }) {
  const tone = stateTone(container);
  const label = container.state
    ? container.state.charAt(0).toUpperCase() + container.state.slice(1)
    : "Unknown";
  const health = container.health;
  return (
    <Badge tone={tone} dot>
      {label}
      {health && health !== "none" ? <span className="text-[10px] opacity-70">· {health}</span> : null}
    </Badge>
  );
}

function MemBar({ used, limit }) {
  const pct = (() => {
    const u = Number(used);
    const l = Number(limit);
    return l > 0 && !Number.isNaN(u) ? Math.min(100, Math.max(0, (u / l) * 100)) : 0;
  })();
  const tone = utilTone(pct);
  return (
    <div className="min-w-[110px]">
      <div className="text-xs tabular-nums text-foreground">{fmtMem(used, limit)}</div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: TONE_VAR[tone] }} />
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
  const [stopping, setStopping] = useState(null); // container pending stop-confirm
  const [history, setHistory] = useState({}); // { [name]: { cpu:[], mem:[] } }

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["infra", "containers"],
    queryFn: () => adminApi.listContainers(),
    refetchInterval: CONTAINERS_REFETCH_MS,
  });

  const host = useQuery({
    queryKey: ["infra", "host"],
    queryFn: () => adminApi.infraHost(),
    refetchInterval: CONTAINERS_REFETCH_MS,
    retry: false,
  });

  const containers = normalize(data);

  // Accumulate a rolling CPU/mem history per container from each poll, so we can
  // draw sparklines the backend snapshot alone can't provide.
  useEffect(() => {
    if (!data) return;
    const rows = normalize(data);
    setHistory((prev) => {
      const next = {};
      rows.forEach((c) => {
        const cpu = Number(c.cpu_pct);
        const h = prev[c.name] || { cpu: [], mem: [] };
        next[c.name] = {
          cpu: [...h.cpu, Number.isNaN(cpu) ? 0 : cpu].slice(-HISTORY_LEN),
          mem: [...h.mem, memPct(c)].slice(-HISTORY_LEN),
        };
      });
      return next;
    });
  }, [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return containers;
    return containers.filter(
      (c) => (c.name || "").toLowerCase().includes(needle) || (c.image || "").toLowerCase().includes(needle)
    );
  }, [containers, q]);

  const runningCount = containers.filter((c) => (c.state || "").toLowerCase() === "running").length;
  const hostRunning = host.data?.containers_running ?? runningCount;
  const hostTotal = host.data?.containers_total ?? containers.length;
  const unhealthy = containers.filter((c) => stateTone(c) === "danger").length;

  // CPU in use, in the same core-scaled unit as each row's cpu_pct.
  // Capacity = logical cores × 100% (e.g. 20 cores → 2000%).
  const cpuUsed = containers.reduce((s, c) => s + (Number(c.cpu_pct) || 0), 0);
  const cores = host.data?.cpu_count;
  const cpuCapacity = cores ? cores * 100 : null;
  const cpuUtil = cpuCapacity ? (cpuUsed / cpuCapacity) * 100 : cpuUsed;

  // Host memory used / total (fall back to container-derived figures).
  const memUsed = host.data?.mem_used_mb ?? containers.reduce((s, c) => s + (Number(c.mem_used_mb) || 0), 0);
  const memTotal = host.data?.mem_total_mb ?? Math.max(0, ...containers.map((c) => Number(c.mem_limit_mb) || 0));
  const memUtil = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["infra", "containers"] });

  async function runAction(name, action) {
    setBusy((b) => ({ ...b, [name]: action }));
    try {
      if (action === "restart") await adminApi.restartContainer(name);
      else if (action === "stop") await adminApi.stopContainer(name);
      else if (action === "start") await adminApi.startContainer(name);
      toast.success(`${action === "restart" ? "Restarted" : action === "stop" ? "Stopped" : "Started"} ${name}`);
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
      <PageHeader
        title="Infrastructure"
        description="Live container fleet on the host — state, resources, trends, logs, and scaling."
        actions={<ScaleControl />}
      />

      {/* Summary */}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Containers"
          value={`${hostRunning} / ${hostTotal}`}
          icon={Server}
          hint={unhealthy ? `${unhealthy} unhealthy` : "all healthy"}
          tone={unhealthy ? "danger" : "success"}
        />
        <StatCard
          label="CPU in use"
          value={cpuCapacity ? `${cpuUsed.toFixed(2)}% / ${cpuCapacity}%` : fmtPct(cpuUsed)}
          icon={Cpu}
          hint={cores ? `${cores} logical cores` : undefined}
          tone={utilTone(cpuUtil) === "accent" ? "muted" : utilTone(cpuUtil)}
        />
        <StatCard
          label="Memory in use"
          value={`${fmtMB(memUsed)} / ${fmtMB(memTotal)}`}
          icon={MemoryStick}
          hint={memTotal > 0 ? `${memUtil.toFixed(0)}% used` : undefined}
          tone={utilTone(memUtil) === "accent" ? "muted" : utilTone(memUtil)}
        />
        <StatCard
          label="Auto-refresh"
          value="4s"
          icon={Activity}
          hint={isFetching ? "updating…" : "live"}
          tone={isFetching ? "success" : "muted"}
        />
      </div>

      {/* Search */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or image…" className="pl-9" />
        </div>
      </div>

      {/* Containers table */}
      <div className="overflow-hidden rounded-2xl border border-card-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-card-border text-xs uppercase tracking-wide text-muted">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-5 py-3 font-medium">State</th>
                <th className="px-5 py-3 font-medium">CPU</th>
                <th className="px-5 py-3 font-medium">Memory</th>
                <th className="px-5 py-3 font-medium">Trend</th>
                <th className="px-5 py-3 font-medium">Uptime</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-card-border last:border-0">
                    {Array.from({ length: 7 }).map((__, j) => (
                      <td key={j} className="px-5 py-4">
                        <Skeleton className="h-3.5 w-full max-w-[120px]" />
                      </td>
                    ))}
                  </tr>
                ))}

              {isError && (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-danger">
                    {apiError(error, "Failed to load containers")}
                  </td>
                </tr>
              )}

              {!isLoading && !isError && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <EmptyState
                      icon={Boxes}
                      title={q ? "No matching containers" : "No containers found"}
                      description={q ? "Try a different filter." : "The host reports no running containers."}
                    />
                  </td>
                </tr>
              )}

              {!isLoading &&
                !isError &&
                filtered.map((c) => {
                  const isRunning = (c.state || "").toLowerCase() === "running";
                  const rowBusy = busy[c.name];
                  const cpuTone = utilTone(Number(c.cpu_pct) || 0);
                  const hist = history[c.name] || { cpu: [], mem: [] };
                  return (
                    <tr
                      key={c.id || c.name}
                      className="cursor-pointer border-b border-card-border last:border-0 transition hover:bg-hover"
                      onClick={() => setSelected(c.name)}
                    >
                      <td className="px-5 py-3.5">
                        <div className="font-medium text-foreground">{c.name}</div>
                        <div className="max-w-[220px] truncate font-mono text-xs text-muted">{c.image || "—"}</div>
                      </td>
                      <td className="px-5 py-3.5">
                        <StateBadge container={c} />
                      </td>
                      <td className="px-5 py-3.5">
                        <span className={"inline-flex items-center gap-1.5 tabular-nums " + TONE_TEXT[cpuTone]}>
                          <Cpu className="h-3.5 w-3.5 opacity-70" />
                          {fmtPct(c.cpu_pct)}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <MemBar used={c.mem_used_mb} limit={c.mem_limit_mb} />
                      </td>
                      <td className="px-5 py-3.5">
                        <Sparkline data={hist.cpu} color={TONE_VAR[cpuTone]} />
                      </td>
                      <td className="px-5 py-3.5 text-muted tabular-nums">{uptime(c.created_at)}</td>
                      <td className="px-5 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            variant="outline"
                            size="icon"
                            title="Restart"
                            aria-label="Restart"
                            loading={rowBusy === "restart"}
                            disabled={!!rowBusy}
                            onClick={() => runAction(c.name, "restart")}
                            className="hover:border-warning/40 hover:text-warning"
                          >
                            {rowBusy !== "restart" && <RotateCcw className="h-3.5 w-3.5" />}
                          </Button>
                          {isRunning ? (
                            <Button
                              variant="outline"
                              size="icon"
                              title="Stop"
                              aria-label="Stop"
                              loading={rowBusy === "stop"}
                              disabled={!!rowBusy}
                              onClick={() => setStopping(c)}
                              className="hover:border-danger/40 hover:text-danger"
                            >
                              {rowBusy !== "stop" && <Square className="h-3.5 w-3.5" />}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="icon"
                              title="Start"
                              aria-label="Start"
                              loading={rowBusy === "start"}
                              disabled={!!rowBusy}
                              onClick={() => runAction(c.name, "start")}
                              className="hover:border-success/40 hover:text-success"
                            >
                              {rowBusy !== "start" && <Play className="h-3.5 w-3.5" />}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 text-xs text-muted">
        {containers.length} container{containers.length === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </div>

      {selected && <LogsDrawer name={selected} onClose={() => setSelected(null)} />}

      <ConfirmDialog
        open={!!stopping}
        onOpenChange={(o) => !o && setStopping(null)}
        title="Stop container?"
        description={stopping ? `“${stopping.name}” will be stopped. Dependent services may be affected.` : ""}
        confirmLabel="Stop container"
        onConfirm={() => {
          if (stopping) runAction(stopping.name, "stop");
          setStopping(null);
        }}
      />
    </div>
  );
}

// ── scale control ──────────────────────────────────────────────────────────
function ScaleControl() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [replicas, setReplicas] = useState(1);

  const scale = useMutation({
    mutationFn: () => adminApi.scaleService(name.trim(), Number(replicas)),
    onSuccess: (res) => {
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
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ServerCog className="h-4 w-4" />
        Scale service
      </Button>
    );
  }

  return (
    <form onSubmit={submit} className="flex shrink-0 items-center gap-2 rounded-lg border border-card-border bg-card p-1.5">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="service name"
        autoFocus
        className="h-8 w-36 rounded-md border border-card-border bg-card px-2.5 text-xs text-foreground placeholder:text-muted outline-none transition focus:border-accent/60"
      />
      <input
        type="number"
        min={0}
        value={replicas}
        onChange={(e) => setReplicas(e.target.value)}
        className="h-8 w-16 rounded-md border border-card-border bg-card px-2.5 text-xs tabular-nums text-foreground outline-none transition focus:border-accent/60"
      />
      <Button type="submit" size="sm" loading={scale.isPending}>
        Scale
      </Button>
      <button type="button" onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted transition hover:bg-hover hover:text-foreground" aria-label="Cancel">
        <X className="h-3.5 w-3.5" />
      </button>
    </form>
  );
}

// ── logs drawer ────────────────────────────────────────────────────────────
function lineTone(line) {
  const s = line.toUpperCase();
  if (/\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|TRACEBACK)\b/.test(s)) return "text-danger";
  if (/\b(WARN|WARNING)\b/.test(s)) return "text-warning";
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

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

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
        <div className="flex items-start justify-between gap-4 border-b border-card-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Boxes className="h-4 w-4 text-accent" />
              <span className="truncate font-mono">{name}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted">Tailing container logs</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

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

          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className={"h-3.5 w-3.5 " + (isFetching ? "animate-spin" : "")} />
            Refresh
          </Button>

          <button
            onClick={() => setAuto((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition " +
              (auto
                ? "border-success/30 bg-success/10 text-success"
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
              className="h-8 w-full rounded-lg border border-card-border bg-card pl-8 pr-3 text-xs text-foreground placeholder:text-muted outline-none transition focus:border-accent/60"
            />
          </div>
        </div>

        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto bg-black/40 px-4 py-3 font-mono text-xs leading-relaxed">
          {isLoading ? (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading logs…
            </div>
          ) : isError ? (
            <div className="flex h-full items-center justify-center text-danger">{apiError(error, "Failed to load logs")}</div>
          ) : shown.length === 0 ? (
            <div className="flex h-full items-center justify-center text-muted">
              {filter ? "No lines match the filter." : "No log output."}
            </div>
          ) : (
            shown.map((line, i) => (
              <div key={i} className={"whitespace-pre-wrap break-all " + lineTone(line)}>
                {line || " "}
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
