"use client";

// CPU / RAM of the machine the wall is served from, in the toolbar.
//
// A wall is the one screen where load is operational, not trivia: tiles are
// decoded here, and when a nine-up grid starts dropping frames the first
// question is whether the box is out of headroom. It reads the same
// /system/resources the Health page does — no second source, no estimate.
//
// Two numbers and no words, because this row is width a tile does not get; the
// title spells them out. It renders NOTHING until the first sample lands, and
// disappears if the endpoint refuses: an operator without `system.read` gets no
// chip rather than a permanent "0% / 0%", which would be a claim about the host.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { api } from "@/lib/api";
import type { SystemResourcesSnapshot } from "@/lib/types";

/** Green healthy, amber busy, red saturated. */
const BUSY = 75;
const SATURATED = 90;

/** The colour ONE reading gets. Per metric, not per chip: a host at 30% CPU and
 *  95% RAM is a memory problem, and a single worst-of tone would say only that
 *  something is wrong — which is the half of the answer an operator already has
 *  from the wall stuttering. */
export function loadTone(pct: number | null): string {
  if (pct == null) return "text-[#7e93bf]";
  if (pct >= SATURATED) return "text-[#f87171]";
  if (pct >= BUSY) return "text-[#fbbf24]";
  return "text-[#34d399]";
}

/** The chip's own border follows the worse of the two, so a saturated host is
 *  visible without reading either number. */
function frame(worst: number): string {
  if (worst >= SATURATED) return "border-[rgba(248,113,113,.45)]";
  if (worst >= BUSY) return "border-[rgba(251,191,36,.45)]";
  return "border-[rgba(150,180,245,.22)]";
}

export default function HostLoadChip() {
  const res = useQuery({
    queryKey: ["system-resources"],
    queryFn: () => api.get<SystemResourcesSnapshot>("/system/resources").then((r) => r.data),
    // Slower than Health's 5s: this is a background reading on a screen whose
    // whole job is video, and each sample costs the host a psutil pass.
    refetchInterval: 10_000,
    retry: false,
  });

  const data = res.data;
  const cpu = typeof data?.cpu_percent === "number" ? Math.round(data.cpu_percent) : null;
  const ram = typeof data?.ram?.percent === "number" ? Math.round(data.ram.percent) : null;
  if (cpu == null && ram == null) return null;

  const worst = Math.max(cpu ?? 0, ram ?? 0);
  return (
    <span
      title={`Host load — CPU ${cpu ?? "?"}% · RAM ${ram ?? "?"}%${
        data?.cpu_cores ? ` · ${data.cpu_cores} cores` : ""
      }`}
      className={`inline-flex h-[33px] items-center gap-1.5 rounded-[8px] border bg-[rgba(150,180,245,.04)] px-2 font-mono text-[11px] font-semibold tabular-nums ${frame(worst)}`}
    >
      <Icon icon="heroicons-outline:cpu-chip" className="text-sm text-[#7e93bf]" />
      <span className={loadTone(cpu)}>{cpu ?? "—"}%</span>
      <span className="text-[#7e93bf] opacity-40">·</span>
      <Icon icon="heroicons-outline:circle-stack" className="text-sm text-[#7e93bf]" />
      <span className={loadTone(ram)}>{ram ?? "—"}%</span>
    </span>
  );
}
