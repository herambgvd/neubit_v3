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

// NeuBit gauge color ramp — teal healthy, amber warn, red critical.
function ringColor(percent) {
  if (percent >= 90) return "#f87171"; // nb.crit
  if (percent >= 70) return "#fbbf24"; // nb.warn
  return "#22d3ee"; // nb.teal
}

/* ── Micro heading (mono / uppercase / faint) ─────────────────────────── */
function SectionLabel({ children, count }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="font-mono text-[10px] uppercase tracking-[1.6px] text-[#9a92c8]">
        {children}
      </h2>
      <span className="h-px flex-1 bg-[rgba(160,150,245,.2)]" />
      {count != null && (
        <span className="font-mono text-[10px] tracking-[.4px] text-[#7e93bf]">{count}</span>
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
function ResourceTile({ icon, label, percent, name, sub, iconColor = "#67e8f9" }) {
  return (
    <div
      className="flex items-center gap-3 rounded-[13px] border border-[rgba(160,150,245,.22)] p-4 backdrop-blur-sm"
      style={{ background: "linear-gradient(155deg,rgba(150,180,245,.06),rgba(150,180,245,.02) 70%)" }}
    >
      <Ring percent={percent} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-[#f2f6ff]">
          <Icon icon={icon} className="shrink-0 text-base" style={{ color: iconColor }} />
          <span className="font-mono text-[11px] uppercase tracking-[1.4px] text-[#aec2e8]">
            {label}
          </span>
        </div>
        {name && (
          <div className="mt-0.5 truncate text-xs text-[#cfd0f2]" title={name}>
            {name}
          </div>
        )}
        {sub && <div className="truncate font-mono text-[11px] text-[#7e93bf]">{sub}</div>}
      </div>
    </div>
  );
}

function GpuTile({ gpus }) {
  if (!gpus.length) {
    return (
      <div
        className="flex items-center gap-3 rounded-[13px] border border-[rgba(160,150,245,.22)] p-4 backdrop-blur-sm"
        style={{ background: "linear-gradient(155deg,rgba(150,180,245,.06),rgba(150,180,245,.02) 70%)" }}
      >
        <div className="flex h-[58px] w-[58px] shrink-0 items-center justify-center rounded-full border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)]">
          <Icon icon="heroicons-outline:cpu-chip" className="text-xl text-[#7e93bf]" />
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[11px] uppercase tracking-[1.4px] text-[#aec2e8]">GPU</div>
          <div className="mt-1 inline-flex rounded-full border border-[rgba(160,150,245,.3)] px-2 py-px font-mono text-[10px] uppercase tracking-[.8px] text-[#8f8ac0]">
            CPU host
          </div>
        </div>
      </div>
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
    <div className="flex items-center gap-3 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.03)] p-4">
      <div className="h-[58px] w-[58px] shrink-0 animate-pulse rounded-full bg-[rgba(150,180,245,.08)]" />
      <div className="space-y-2">
        <div className="h-3 w-16 animate-pulse rounded bg-[rgba(150,180,245,.08)]" />
        <div className="h-2.5 w-20 animate-pulse rounded bg-[rgba(150,180,245,.08)]" />
      </div>
    </div>
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
    <div
      className="relative flex h-full min-h-0 w-full flex-col overflow-y-auto p-6 text-[#f2f6ff] lg:p-8"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* masthead + overall status */}
      <div className="mb-6 flex items-center gap-3">
        <Icon icon="heroicons:heart" className="text-2xl text-[#67e8f9]" />
        <div>
          <h1 className="text-[20px] font-extralight tracking-[1px] text-[#f2f6ff]">Pulse</h1>
          <span className="font-mono text-[10px] uppercase tracking-[2px] text-[#9a92c8]">
            System Health
          </span>
        </div>
        {overall && (
          <span
            className="ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[1.2px]"
            style={
              healthy
                ? { color: "#34d399", borderColor: "rgba(52,211,153,.45)", background: "rgba(52,211,153,.08)" }
                : { color: "#f87171", borderColor: "rgba(248,113,113,.55)", background: "rgba(248,113,113,.10)" }
            }
          >
            <span
              className="h-[7px] w-[7px] rounded-full"
              style={{
                background: healthy ? "#34d399" : "#f87171",
                boxShadow: `0 0 8px ${healthy ? "#34d399" : "#f87171"}`,
              }}
            />
            {healthy ? "All systems operational" : "Degraded"}
          </span>
        )}
      </div>

      {/* Dependencies */}
      <section className="mb-8">
        <SectionLabel count={Object.keys(DEP_META).length}>Dependencies</SectionLabel>
        {health.isLoading ? (
          <div className="flex justify-center rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.03)] py-12">
            <Icon icon="heroicons:arrow-path" className="animate-spin text-2xl text-[#67e8f9]" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {Object.entries(DEP_META).map(([key, meta]) => {
              const state = checks[key] || "unknown";
              const ok = state === "ok";
              const dot = ok ? "#34d399" : "#f87171";
              return (
                <div
                  key={key}
                  className="rounded-[13px] border p-5 backdrop-blur-sm"
                  style={{
                    borderColor: ok ? "rgba(160,150,245,.22)" : "rgba(248,113,113,.4)",
                    background: "linear-gradient(155deg,rgba(150,180,245,.06),rgba(150,180,245,.02) 70%)",
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Icon icon={meta.icon} className="text-lg text-[#aec2e8]" />
                      <span className="text-sm font-medium text-[#f2f6ff]">{meta.label}</span>
                    </div>
                    <span
                      className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[1px]"
                      style={{ color: dot }}
                    >
                      <span
                        className="h-[7px] w-[7px] rounded-full"
                        style={{ background: dot, boxShadow: `0 0 8px ${dot}` }}
                      />
                      {ok ? "Healthy" : "Down"}
                    </span>
                  </div>
                  {!ok && (
                    <p className="mt-3 break-all font-mono text-[11px] text-[#f87171]">{state}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Host resources */}
      <section>
        <SectionLabel>Host resources</SectionLabel>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <HostResources />
        </div>
      </section>

      {/* GVD lockup */}
      <div className="mt-auto flex items-center justify-end gap-2 pt-6 font-mono text-[9px] tracking-[1.3px] text-[#9fb2d8]">
        <span>GENIUS VISION DIGITAL · GVD</span>
      </div>
    </div>
  );
}
