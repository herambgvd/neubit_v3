"use client";

// NeuBit VMS — PULSE (system health). Navy/teal command-console reskin of the
// system-health surface. REUSES the existing data hooks/APIs verbatim:
//   • /system/health   → overall status + dependency checks
//   • /system/resources → live host resources (CPU / RAM / Disk / GPU)
// SystemResources.jsx is SHARED with the Dashboard, so its host-resource meters
// are re-implemented inline here in NeuBit tokens rather than editing the shared
// component. Visual spec: design/mockups/neubit-vms-pulse.html.

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { LoadingBlock, SectionCard, ViewActions } from "@/components/console";
import { api } from "@/lib/api";

const DEP_META = {
  database: { label: "Database", icon: "heroicons-outline:circle-stack" },
  redis: { label: "Redis", icon: "heroicons-outline:bolt" },
  storage: { label: "Object storage", icon: "heroicons-outline:server" },
};

function toGB(bytes) {
  if (bytes == null) return "0";
  return (bytes / 1024 ** 3).toFixed(1);
}

// Gauge color ramp — blue healthy (the Configurations accent), amber warn, red critical.
function ringColor(percent) {
  if (percent >= 90) return "#f87171"; // nb.crit
  if (percent >= 70) return "#fbbf24"; // nb.warn
  return "#60a5fa"; // nb.blue — Configurations accent
}

/* ── Micro heading (mono / uppercase / faint) ─────────────────────────── */
function SectionLabel({ children, count }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
        {children}
      </h2>
      <span className="h-px flex-1 bg-nb-line" />
      {count != null && (
        <span className="font-mono text-[10px] tracking-[.4px] text-nb-faint">{count}</span>
      )}
    </div>
  );
}

/* ── Compact radial gauge — track ring + colored progress arc, % centered ─ */
function Ring({ percent, size = 58, stroke = 6 }) {
  const p = Math.min(100, Math.max(0, Math.round(percent ?? 0)));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (p / 100) * circ;
  const col = ringColor(p);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="rgba(150,180,245,.12)"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke={col}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.6s ease", filter: `drop-shadow(0 0 4px ${col}55)` }}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-mono text-xs font-bold"
        style={{ color: col }}
      >
        {p}%
      </span>
    </div>
  );
}

/* ── Navy glass resource tile ─────────────────────────────────────────── */
function ResourceTile({ icon, label, percent, name, sub, iconColor = "#93c5fd" }) {
  return (
    <SectionCard className="flex items-center gap-3">
      <Ring percent={percent} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-nb-ink">
          <Icon icon={icon} className="shrink-0 text-base" style={{ color: iconColor }} />
          <span className="font-mono text-[11px] uppercase tracking-[1.4px] text-nb-soft">
            {label}
          </span>
        </div>
        {name && (
          <div className="mt-0.5 truncate text-xs text-nb-muted" title={name}>
            {name}
          </div>
        )}
        {sub && <div className="truncate font-mono text-[11px] text-nb-faint">{sub}</div>}
      </div>
    </SectionCard>
  );
}

function GpuTile({ gpus }) {
  if (!gpus.length) {
    return (
      <SectionCard className="flex items-center gap-3">
        <div className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-full border border-nb-line bg-white/[.04]">
          <Icon icon="heroicons-outline:cpu-chip" className="text-xl text-nb-faint" />
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[1.4px] text-nb-soft">GPU</div>
          <div className="mt-1 inline-flex rounded-full border border-nb-line px-2 py-px font-mono text-[10px] uppercase tracking-[.8px] text-nb-faint">
            CPU host
          </div>
        </div>
      </SectionCard>
    );
  }
  const g = gpus[0];
  const extra = gpus.length - 1;
  const sub = [
    `${toGB(g.mem_used)} / ${toGB(g.mem_total)} GB`,
    g.temp != null ? `${Math.round(g.temp)}°C` : null,
    extra > 0 ? `+${extra} more` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ResourceTile
      icon="heroicons-outline:cpu-chip"
      iconColor="#93c5fd"
      label={g.name || `GPU ${g.index}`}
      percent={g.util_percent}
      sub={sub}
    />
  );
}

function SkeletonTile() {
  return (
    <SectionCard className="flex items-center gap-3">
      <div className="h-[58px] w-[58px] shrink-0 animate-pulse rounded-full bg-white/5" />
      <div className="space-y-2">
        <div className="h-3 w-16 animate-pulse rounded bg-white/5" />
        <div className="h-2.5 w-20 animate-pulse rounded bg-white/5" />
      </div>
    </SectionCard>
  );
}

/* ── Live host resources (own query — mirrors shared SystemResources API) ─ */
function HostResources() {
  const res = useQuery({
    queryKey: ["system-resources"],
    queryFn: () => api.get("/system/resources").then((r) => r.data),
    refetchInterval: 3000,
  });

  if (res.isLoading) {
    return (
      <>
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
        <SkeletonTile />
      </>
    );
  }

  const data = res.data;
  const gpus = data?.gpus || [];
  const cpuSub = [
    data?.cpu_cores ? `${data.cpu_cores} cores` : null,
    data?.cpu_freq_ghz ? `${data.cpu_freq_ghz} GHz` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <ResourceTile
        icon="heroicons-outline:cpu-chip"
        label="CPU"
        percent={data?.cpu_percent}
        name={data?.cpu_name}
        sub={cpuSub}
      />
      <ResourceTile
        icon="heroicons-outline:circle-stack"
        label="RAM"
        percent={data?.ram?.percent}
        sub={`${toGB(data?.ram?.used)} / ${toGB(data?.ram?.total)} GB`}
      />
      <ResourceTile
        icon="heroicons-outline:server"
        label="Disk"
        percent={data?.disk?.percent}
        sub={`${toGB(data?.disk?.used)} / ${toGB(data?.disk?.total)} GB`}
      />
      <GpuTile gpus={gpus} />
    </>
  );
}

export default function HealthPage() {
  const health = useQuery({
    queryKey: ["system-health"],
    queryFn: () => api.get("/system/health").then((r) => r.data),
    refetchInterval: 10000,
  });

  const checks = health.data?.checks || {};
  const overall = health.data?.status;
  const healthy = overall === "healthy";

  return (
    // A Platform sub-view: PlatformConsole already owns the navy page frame AND the
    // scroll container, so this renders bare content. Nesting a second gradient +
    // a second overflow-y-auto made the pane scroll inside a scroll.
    <div className="relative w-full text-nb-ink">
      {/* Overall status — sits in the same right-aligned action row every other
          Platform view uses, instead of its own oversized masthead. */}
      {overall && (
        <ViewActions>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[1.2px] ${
              healthy ? "border-nb-good/45 bg-nb-good/10 text-nb-good" : "border-nb-crit/55 bg-nb-crit/10 text-nb-crit"
            }`}
          >
            <span
              className={`h-[7px] w-[7px] rounded-full ${
                healthy ? "bg-nb-good shadow-[0_0_8px_#34d399]" : "bg-nb-crit shadow-[0_0_8px_#f87171]"
              }`}
            />
            {healthy ? "All systems operational" : "Degraded"}
          </span>
        </ViewActions>
      )}

      {/* Dependencies */}
      <section className="mb-4">
        <SectionLabel count={Object.keys(DEP_META).length}>Dependencies</SectionLabel>
        {health.isLoading ? (
          <LoadingBlock />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {Object.entries(DEP_META).map(([key, meta]) => {
              const state = checks[key] || "unknown";
              const ok = state === "ok";
              return (
                <SectionCard key={key} className={ok ? "" : "!border-nb-crit/40"}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon icon={meta.icon} className="text-lg text-nb-blueb" />
                      <span className="text-sm font-medium text-nb-ink">{meta.label}</span>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[1px] ${
                        ok ? "text-nb-good" : "text-nb-crit"
                      }`}
                    >
                      <span
                        className={`h-[7px] w-[7px] rounded-full ${
                          ok ? "bg-nb-good shadow-[0_0_8px_#34d399]" : "bg-nb-crit shadow-[0_0_8px_#f87171]"
                        }`}
                      />
                      {ok ? "Healthy" : "Down"}
                    </span>
                  </div>
                  {!ok && (
                    <p className="mt-3 break-all font-mono text-[11px] text-nb-crit">{state}</p>
                  )}
                </SectionCard>
              );
            })}
          </div>
        )}
      </section>

      {/* Host resources */}
      <section>
        <SectionLabel>Host resources</SectionLabel>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <HostResources />
        </div>
      </section>
    </div>
  );
}
