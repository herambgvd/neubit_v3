"use client";

// VMS → Operations / Health Dashboard (G2). A live control-room overview of the
// whole estate: camera reachability, recording throughput, storage capacity +
// days-to-full forecast, media-node / data-plane health with failover flags, and
// a recent-alarms strip. One request to GET /api/v1/vms/dashboard/summary rolls up
// every section server-side (best-effort — zeros for an empty tenant, "unknown"
// for the node section when the Go nvr is unreachable). Auto-refreshes every 12s.
//
// Reads gate on vms.camera.read (the same read perm the health/cameras surface
// uses). The gateway routes /api/v1/vms/dashboard/* → the vision service.
import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { PageHeader, Button, Badge } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { fmtBytes, fmtRelative, titleize } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { vms } from "./api";

const REFRESH_MS = 12_000;

export default function DashboardPage() {
  const { can } = useAuth();
  const canRead = can("vms.camera.read") || can("neubit.read");

  const q = useQuery({
    queryKey: ["vms-dashboard-summary"],
    queryFn: () => vms.dashboard.summary(),
    enabled: canRead,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    keepPreviousData: true,
  });

  const d = q.data;

  if (!canRead) {
    return (
      <div className="pb-8">
        <PageHeader title="Operations Dashboard" />
        <div className="rounded-xl border border-card-border bg-card py-16 text-center text-sm text-muted">
          You don't have permission to view the operations dashboard.
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <PageHeader
        title="Operations Dashboard"
        subtitle="Live health of the estate — cameras, recording, storage, media nodes and alarms."
        actions={
          <div className="flex items-center gap-3">
            {d?.generated_at && (
              <span className="hidden items-center gap-1.5 text-[11px] text-muted sm:inline-flex">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${q.isFetching ? "animate-pulse bg-emerald-500" : "bg-emerald-500/60"}`}
                />
                updated {fmtRelative(d.generated_at)}
              </span>
            )}
            <Button
              variant="secondary"
              icon="heroicons-outline:arrow-path"
              onClick={() => q.refetch()}
            >
              Refresh
            </Button>
          </div>
        }
      />

      {q.isLoading && !d ? (
        <LoadingState />
      ) : q.isError && !d ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-12 text-center text-sm text-red-500">
          {apiError(q.error, "Failed to load the dashboard")}
        </div>
      ) : d ? (
        <DashboardBody d={d} />
      ) : null}
    </div>
  );
}

function DashboardBody({ d }) {
  const cams = d.cameras || {};
  const rec = d.recording || {};
  const storage = d.storage || {};
  const nodes = d.nodes || {};
  const alarms = d.alarms || {};
  const nvrs = d.nvrs || {};

  return (
    <div className="space-y-6">
      {/* ── KPI cards ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiCard
          icon="heroicons:video-camera"
          accent="blue"
          label="Cameras online"
          value={`${cams.online ?? 0}/${cams.total ?? 0}`}
          sub={
            (cams.offline || 0) + (cams.degraded || 0) > 0
              ? `${cams.offline || 0} offline · ${cams.degraded || 0} degraded`
              : "all reachable"
          }
          tone={cams.offline ? "warn" : "ok"}
        />
        <KpiCard
          icon="heroicons:film"
          accent="emerald"
          label="Recording"
          value={rec.recording ?? 0}
          sub={
            rec.failed
              ? `${rec.failed} failed · ${rec.idle ?? 0} idle`
              : `${rec.idle ?? 0} idle`
          }
          tone={rec.failed ? "bad" : "ok"}
        />
        <KpiCard
          icon="heroicons:circle-stack"
          accent="amber"
          label="Storage used"
          value={storage.used_pct != null ? `${Math.round(storage.used_pct)}%` : "—"}
          sub={`${fmtBytes(storage.total_used_bytes || 0)} of ${
            storage.total_capacity_bytes ? fmtBytes(storage.total_capacity_bytes) : "∞"
          }`}
          tone={
            storage.used_pct != null && storage.used_pct >= 90
              ? "bad"
              : storage.used_pct != null && storage.used_pct >= 75
                ? "warn"
                : "ok"
          }
        />
        <KpiCard
          icon="heroicons:bell-alert"
          accent="rose"
          label="Alarms (24h)"
          value={alarms.total ?? 0}
          sub={
            alarms.unacknowledged
              ? `${alarms.unacknowledged} unacknowledged`
              : "all acknowledged"
          }
          tone={alarms.unacknowledged ? "warn" : "ok"}
        />
        <KpiCard
          icon="heroicons:server-stack"
          accent="indigo"
          label="NVRs healthy"
          value={`${nvrs.healthy ?? 0}/${nvrs.total ?? 0}`}
          sub={nvrs.unhealthy ? `${nvrs.unhealthy} unhealthy` : "all healthy"}
          tone={nvrs.unhealthy ? "bad" : "ok"}
        />
      </div>

      {/* ── Camera health + Recording throughput ─────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CameraHealthCard cams={cams} />
        <RecordingCard rec={rec} />
      </div>

      {/* ── Storage pools ────────────────────────────────────────────────── */}
      <StorageCard storage={storage} />

      {/* ── Nodes / data plane + Recent alarms ───────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <NodesCard nodes={nodes} />
        <RecentAlarmsCard alarms={alarms} />
      </div>
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────────────
const ACCENTS = {
  blue: "text-blue-500 bg-blue-500/10",
  emerald: "text-emerald-500 bg-emerald-500/10",
  amber: "text-amber-500 bg-amber-500/10",
  rose: "text-rose-500 bg-rose-500/10",
  indigo: "text-indigo-500 bg-indigo-500/10",
};
const TONE_DOT = { ok: "bg-emerald-500", warn: "bg-amber-500", bad: "bg-red-500" };

function KpiCard({ icon, accent = "blue", label, value, sub, tone = "ok" }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-card-border bg-card p-4">
      <div className="flex items-start justify-between">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${ACCENTS[accent] || ACCENTS.blue}`}>
          <Icon icon={icon} className="text-lg" />
        </div>
        <span className={`mt-1 h-2 w-2 rounded-full ${TONE_DOT[tone] || TONE_DOT.ok}`} title={tone} />
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-foreground tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      {sub && <div className="mt-1.5 truncate text-xs text-muted" title={sub}>{sub}</div>}
    </div>
  );
}

// ── Section shell ────────────────────────────────────────────────────────────
function SectionCard({ title, icon, right, children }) {
  return (
    <div className="rounded-xl border border-card-border bg-card">
      <div className="flex items-center justify-between border-b border-card-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon && <Icon icon={icon} className="text-base text-muted" />}
          {title}
        </h2>
        {right}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ── Camera health rollup — stacked split bar + legend ────────────────────────
function CameraHealthCard({ cams }) {
  const total = cams.total || 0;
  const segs = [
    { key: "online", label: "Online", value: cams.online || 0, color: "bg-emerald-500", text: "text-emerald-500" },
    { key: "degraded", label: "Degraded", value: cams.degraded || 0, color: "bg-amber-500", text: "text-amber-500" },
    { key: "offline", label: "Offline", value: cams.offline || 0, color: "bg-red-500", text: "text-red-500" },
    { key: "other", label: "Other", value: cams.other || 0, color: "bg-muted/50", text: "text-muted" },
  ];
  const onlinePct = total > 0 ? Math.round(((cams.online || 0) / total) * 100) : 0;

  return (
    <SectionCard
      title="Camera health"
      icon="heroicons:video-camera"
      right={<span className="text-xs text-muted">{onlinePct}% online</span>}
    >
      {total === 0 ? (
        <EmptyRow icon="heroicons:video-camera-slash" text="No cameras onboarded yet." />
      ) : (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-hover">
            {segs.map((s) =>
              s.value > 0 ? (
                <div
                  key={s.key}
                  className={s.color}
                  style={{ width: `${(s.value / total) * 100}%` }}
                  title={`${s.label}: ${s.value}`}
                />
              ) : null,
            )}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {segs.map((s) => (
              <div key={s.key} className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${s.color}`} />
                <div>
                  <div className="text-base font-semibold tabular-nums text-foreground">{s.value}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted">{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ── Recording throughput ─────────────────────────────────────────────────────
function RecordingCard({ rec }) {
  return (
    <SectionCard title="Recording" icon="heroicons:film">
      <div className="grid grid-cols-3 gap-3">
        <MiniStat label="Active" value={rec.recording ?? 0} tone="ok" />
        <MiniStat label="Idle" value={rec.idle ?? 0} tone="neutral" />
        <MiniStat label="Failed" value={rec.failed ?? 0} tone={rec.failed ? "bad" : "ok"} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-card-border pt-4">
        <div>
          <div className="text-lg font-semibold tabular-nums text-foreground">{fmtBytes(rec.bytes_last_24h || 0)}</div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Recorded (24h)</div>
        </div>
        <div>
          <div className="text-lg font-semibold tabular-nums text-foreground">
            {(rec.total_segments ?? 0).toLocaleString()}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-muted">Total segments</div>
        </div>
      </div>
    </SectionCard>
  );
}

function MiniStat({ label, value, tone = "neutral" }) {
  const color =
    tone === "ok" ? "text-emerald-500" : tone === "bad" && value ? "text-red-500" : "text-foreground";
  return (
    <div className="rounded-lg border border-card-border bg-hover/30 px-3 py-2.5 text-center">
      <div className={`text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

// ── Storage pools — per-pool gauge bars ──────────────────────────────────────
function StorageCard({ storage }) {
  const pools = storage.pools || [];
  return (
    <SectionCard
      title="Storage"
      icon="heroicons:circle-stack"
      right={
        <span className="text-xs text-muted">
          {fmtBytes(storage.total_used_bytes || 0)}
          {storage.total_capacity_bytes ? ` / ${fmtBytes(storage.total_capacity_bytes)}` : ""}
          {storage.used_pct != null ? ` · ${Math.round(storage.used_pct)}%` : ""}
        </span>
      }
    >
      {pools.length === 0 ? (
        <EmptyRow icon="heroicons:circle-stack" text="No storage pools configured." />
      ) : (
        <div className="space-y-4">
          {pools.map((p) => (
            <PoolGauge key={p.id} pool={p} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function PoolGauge({ pool }) {
  const pct = pool.used_pct != null ? Math.min(100, Math.max(0, pool.used_pct)) : null;
  const barColor =
    pct == null ? "bg-blue-500" : pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-emerald-500";
  const dtf = pool.days_to_full;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{pool.name}</span>
          <Badge color="neutral">{titleize(pool.type)}</Badge>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted">
          <span className="tabular-nums text-foreground">
            {fmtBytes(pool.used_bytes || 0)}
            {pool.capacity_bytes ? ` / ${fmtBytes(pool.capacity_bytes)}` : " (unlimited)"}
          </span>
          {dtf != null && (
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                dtf <= 7
                  ? "bg-red-500/15 text-red-500"
                  : dtf <= 30
                    ? "bg-amber-500/15 text-amber-500"
                    : "bg-hover text-muted"
              }`}
              title="Estimated days until full (linear forecast)"
            >
              {dtf < 1 ? "<1d to full" : `${Math.round(dtf)}d to full`}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-hover">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct ?? 4}%` }} />
        </div>
        <span className="w-10 text-right text-xs font-semibold tabular-nums text-foreground">
          {pct != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </div>
    </div>
  );
}

// ── Media nodes / data plane ─────────────────────────────────────────────────
function NodesCard({ nodes }) {
  const unknown = nodes.data_plane === "unknown";
  const list = nodes.nodes || [];
  const flags = [
    { key: "resilience", label: "Resilience", value: nodes.resilience },
    { key: "streaming", label: "Streaming", value: nodes.streaming },
    { key: "recording", label: "Recording", value: nodes.recording },
    { key: "nats", label: "NATS", value: nodes.nats },
  ];
  return (
    <SectionCard
      title="Media nodes"
      icon="heroicons:server-stack"
      right={
        <Badge color={unknown ? "neutral" : nodes.unhealthy ? "amber" : "green"}>
          {unknown ? "data plane unknown" : `${nodes.healthy ?? 0}/${nodes.total ?? 0} healthy`}
        </Badge>
      }
    >
      {/* Failover / capability flags */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {flags.map((f) => (
          <FlagPill key={f.key} label={f.label} value={f.value} unknown={unknown} />
        ))}
      </div>

      {unknown && list.length === 0 ? (
        <EmptyRow icon="heroicons:question-mark-circle" text="Go nvr unreachable — node status unavailable." />
      ) : list.length === 0 ? (
        <EmptyRow icon="heroicons:server-stack" text="No media nodes registered." />
      ) : (
        <div className="space-y-2">
          {list.map((n) => (
            <div
              key={n.id}
              className="flex items-center justify-between rounded-lg border border-card-border bg-hover/20 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${n.healthy ? "bg-emerald-500" : "bg-red-500"}`} />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{n.name || n.id}</div>
                  <div className="text-[11px] text-muted">
                    {titleize(n.status || "unknown")}
                    {n.last_heartbeat ? ` · ${fmtRelative(n.last_heartbeat)}` : ""}
                  </div>
                </div>
              </div>
              <div className="whitespace-nowrap text-xs tabular-nums text-muted">
                {n.used_channels ?? 0}/{n.capacity_channels ?? 0} ch
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function FlagPill({ label, value, unknown }) {
  const state = unknown || value == null ? "unknown" : value ? "ok" : "bad";
  const cls =
    state === "ok"
      ? "bg-emerald-500/10 text-emerald-500"
      : state === "bad"
        ? "bg-red-500/10 text-red-500"
        : "bg-hover text-muted";
  const icon =
    state === "ok"
      ? "heroicons:check-circle"
      : state === "bad"
        ? "heroicons:x-circle"
        : "heroicons:minus-circle";
  return (
    <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${cls}`}>
      <Icon icon={icon} className="text-sm" />
      {label}
    </div>
  );
}

// ── Recent alarms strip ──────────────────────────────────────────────────────
const SEV_COLOR = {
  critical: "bg-red-500",
  high: "bg-red-500",
  error: "bg-red-500",
  major: "bg-orange-500",
  warning: "bg-amber-500",
  medium: "bg-amber-500",
  minor: "bg-amber-500",
  info: "bg-blue-500",
  low: "bg-blue-500",
};

function RecentAlarmsCard({ alarms }) {
  const recent = alarms.recent || [];
  const bySeverity = useMemo(
    () => (alarms.by_severity || []).filter((b) => b.count > 0),
    [alarms.by_severity],
  );
  return (
    <SectionCard
      title="Recent alarms"
      icon="heroicons:bell-alert"
      right={
        <Link href="/camera-events" className="text-xs text-blue-500 transition hover:underline">
          View all
        </Link>
      }
    >
      {bySeverity.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {bySeverity.map((b) => (
            <span
              key={b.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-hover/40 px-2 py-0.5 text-[11px] text-muted"
            >
              <span className={`h-2 w-2 rounded-full ${SEV_COLOR[b.key?.toLowerCase()] || "bg-muted"}`} />
              <span className="capitalize text-foreground">{titleize(b.key)}</span>
              <span className="tabular-nums">{b.count}</span>
            </span>
          ))}
        </div>
      )}

      {recent.length === 0 ? (
        <EmptyRow icon="heroicons:check-circle" text="No alarms in the last 24 hours." />
      ) : (
        <div className="divide-y divide-card-border/60">
          {recent.map((e) => (
            <div key={e.id} className="flex items-center gap-3 py-2.5">
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${SEV_COLOR[e.severity?.toLowerCase()] || "bg-muted"}`}
                title={e.severity}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {e.title || titleize(e.event_type)}
                </div>
                <div className="truncate text-[11px] text-muted">
                  {titleize(e.event_type)}
                  {e.camera_id ? ` · cam ${String(e.camera_id).slice(0, 8)}` : ""}
                </div>
              </div>
              <span className="whitespace-nowrap text-[11px] text-muted">{fmtRelative(e.occurred_at)}</span>
              {e.acknowledged ? (
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                  ack
                </span>
              ) : (
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                  new
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────
function EmptyRow({ icon, text }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <Icon icon={icon} className="mb-1.5 text-2xl text-muted opacity-50" />
      <p className="text-sm text-muted">{text}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-card-border bg-card" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-52 animate-pulse rounded-xl border border-card-border bg-card" />
        <div className="h-52 animate-pulse rounded-xl border border-card-border bg-card" />
      </div>
      <div className="h-40 animate-pulse rounded-xl border border-card-border bg-card" />
    </div>
  );
}
