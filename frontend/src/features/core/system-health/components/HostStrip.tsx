"use client";

// The strip above the estate: core's dependency probes and the host's meters.
//
// These were two full sections with their own headings and 58px gauges, which
// pushed the services and their logs — the reason the page exists — below the
// fold. Same facts, one row: a chip per dependency, a bar per resource.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import type { GpuSample, SystemResourcesSnapshot } from "@/lib/types";
import type { SystemHealthOut } from "../../types";

const DEP_META: Record<string, { label: string; icon: string }> = {
  database: { label: "Database", icon: "heroicons-outline:circle-stack" },
  redis: { label: "Redis", icon: "heroicons-outline:bolt" },
  storage: { label: "Storage", icon: "heroicons-outline:server" },
};

function toGB(bytes: number | null | undefined): string {
  return bytes == null ? "0" : (bytes / 1024 ** 3).toFixed(1);
}

/** Blue healthy, amber busy, red saturated — the same ramp the gauges used. */
function meterColor(percent: number): string {
  if (percent >= 90) return "#f87171";
  if (percent >= 70) return "#fbbf24";
  return "#60a5fa";
}

function Meter({
  icon,
  label,
  percent,
  sub,
}: {
  icon: string;
  label: string;
  percent: number | null | undefined;
  sub?: string | null;
}) {
  const p = Math.min(100, Math.max(0, Math.round(percent ?? 0)));
  const col = meterColor(p);
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Icon icon={icon} className="shrink-0 text-[13px] text-nb-blueb" />
        <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-nb-soft">{label}</span>
        <span className="ml-auto font-mono text-[11px] font-bold" style={{ color: col }}>
          {p}%
        </span>
      </div>
      <div
        className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[.08]"
        role="progressbar"
        aria-label={label}
        aria-valuenow={p}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${p}%`, background: col, boxShadow: `0 0 6px ${col}66` }}
        />
      </div>
      {sub && <div className="mt-1 truncate font-mono text-[10px] text-nb-faint">{sub}</div>}
    </div>
  );
}

function gpuSub(gpus: GpuSample[]): string | null {
  if (!gpus.length) return "CPU host";
  const g = gpus[0];
  return [
    `${toGB(g.mem_used)} / ${toGB(g.mem_total)} GB`,
    g.temp != null ? `${Math.round(g.temp)}°C` : null,
    gpus.length > 1 ? `+${gpus.length - 1}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export interface HostStripProps {
  health: SystemHealthOut | undefined;
  loading?: boolean;
}

export default function HostStrip({ health, loading }: HostStripProps) {
  const res = useQuery({
    queryKey: ["system-resources"],
    queryFn: () => api.get<SystemResourcesSnapshot>("/system/resources").then((r) => r.data),
    refetchInterval: 5000,
  });

  const data = res.data;
  const gpus = data?.gpus || [];
  const checks = health?.checks || {};

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {Object.entries(DEP_META).map(([key, meta]) => {
        const state = loading ? "…" : checks[key] || "unknown";
        const ok = state === "ok";
        return (
          <div
            key={key}
            className={`rounded-[10px] border px-3 py-2 ${ok ? "border-nb-line bg-[rgba(8,15,34,.5)]" : "border-nb-crit/40 bg-nb-crit/[.07]"}`}
            title={ok ? undefined : state}
          >
            <div className="flex items-center gap-1.5">
              <Icon icon={meta.icon} className="shrink-0 text-[13px] text-nb-blueb" />
              <span className="font-mono text-[10px] uppercase tracking-[1.2px] text-nb-soft">
                {meta.label}
              </span>
              <span
                className={`ml-auto h-[7px] w-[7px] shrink-0 rounded-full ${
                  ok ? "bg-nb-good shadow-[0_0_6px_#34d399]" : "bg-nb-crit shadow-[0_0_6px_#f87171]"
                }`}
              />
            </div>
            <div
              className={`mt-1.5 truncate font-mono text-[10px] ${ok ? "text-nb-faint" : "text-nb-crit"}`}
            >
              {/* The probe's own message when it fails: "error: connection refused"
                  is the whole diagnosis, and hiding it behind "Down" cost a
                  round-trip to the logs every time. */}
              {loading ? "checking…" : ok ? "reachable" : state}
            </div>
          </div>
        );
      })}

      <Meter
        icon="heroicons-outline:cpu-chip"
        label="CPU"
        percent={data?.cpu_percent}
        sub={[data?.cpu_cores ? `${data.cpu_cores} cores` : null, data?.cpu_freq_ghz ? `${data.cpu_freq_ghz} GHz` : null]
          .filter(Boolean)
          .join(" · ")}
      />
      <Meter
        icon="heroicons-outline:circle-stack"
        label="RAM"
        percent={data?.ram?.percent}
        sub={`${toGB(data?.ram?.used)} / ${toGB(data?.ram?.total)} GB`}
      />
      <Meter
        icon="heroicons-outline:server"
        label="Disk"
        percent={data?.disk?.percent}
        sub={`${toGB(data?.disk?.used)} / ${toGB(data?.disk?.total)} GB`}
      />
      <Meter
        icon="heroicons-outline:sparkles"
        label="GPU"
        percent={gpus.length ? gpus[0].util_percent : 0}
        sub={gpuSub(gpus)}
      />
    </div>
  );
}
