"use client";

// Scheduled Access. Ported from neubit_v2's scheduled-tab.jsx — SAME sub-tab shell
// (Scheduled MAGs / Scheduled Readers / Weekly Programs).
//
// v3 wiring:
//   • Scheduled MAGs / Scheduled Readers — READ-ONLY inventory proxied live from
//     the controller (GET /access/instances/{id}/scheduled/{scheduled_mags|
//     scheduled_readers}; connector → API_ScheduledMAGs / API_ScheduledAdditionalReaders).
//   • Weekly Programs — the schedules catalog (API_WeeklyPrograms), served by
//     the existing GET /access/schedules?instance_id= route.
// Columns are picked generically from the returned DTOs (the DDS shapes vary by
// firmware), mirroring HardwareTab. Write-through for MAGs is intentionally NOT
// exposed here — it needs a verified DDS OData write field-map (not faked).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import type { HardwareListResponse, ScheduleListResponse } from "../types";

/** The three sub-tabs: two live controller proxies plus the schedules catalog. */
type ScheduledSub = "mags" | "readers" | "weekly";

const SUB_TABS: { key: ScheduledSub; label: string }[] = [
  { key: "mags", label: "Scheduled MAGs" },
  { key: "readers", label: "Scheduled Readers" },
  { key: "weekly", label: "Weekly Programs" },
];

const COPY: Record<ScheduledSub, string> = {
  mags: "Temporary cardholder → security-group grants between two dates, read live from the controller.",
  readers: "Per-reader scheduled weekly-program assignments, read live from the controller.",
  weekly: "The weekly-program inventory synced from the controller.",
};

// Prefer human-friendly keys first, then fill from whatever the DTO carries.
function pickColumns(items: Record<string, unknown>[]): string[] {
  const PREFERRED = [
    "Name",
    "UID",
    "Description",
    "CardholderUID",
    "ReaderUID",
    "ScheduledSecurityGroupUID",
    "OriginSecurityGroupUID",
    "ScheduledWeeklyProgramUID",
    "OriginWeeklyProgramUID",
    "FromDateValid",
    "ToDateValid",
  ];
  if (!items.length) return [];
  const keys = new Set<string>();
  items.slice(0, 50).forEach((it) => Object.keys(it || {}).forEach((k) => keys.add(k)));
  const ordered: string[] = [];
  PREFERRED.forEach((f) => {
    if (keys.has(f)) {
      ordered.push(f);
      keys.delete(f);
    }
  });
  Array.from(keys)
    .filter((k) => !k.startsWith("@"))
    .slice(0, Math.max(0, 8 - ordered.length))
    .forEach((k) => ordered.push(k));
  return ordered;
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted/70">—</span>;
  if (typeof value === "object") return <code className="text-[10px] text-muted">{JSON.stringify(value)}</code>;
  const str = String(value);
  return str.length > 48 ? <span title={str}>{str.slice(0, 48)}…</span> : str;
}

interface ScheduledListProps {
  instanceId: string;
  sub: ScheduledSub;
}

function ScheduledList({ instanceId, sub }: ScheduledListProps) {
  // The three sub-tabs hit two different routes, so the response type is the
  // union of what they return; the table reads it generically either way.
  const q = useQuery<ScheduleListResponse | HardwareListResponse>({
    queryKey: ["ac-scheduled", instanceId, sub],
    queryFn: () =>
      sub === "weekly"
        ? gates.schedules.list(instanceId, { limit: 200 })
        : gates.scheduled.list(instanceId, sub === "mags" ? "scheduled_mags" : "scheduled_readers", {
            limit: 200,
          }),
    enabled: !!instanceId,
  });
  // Weekly Programs come back as `SchedulePublic`, the other two as raw controller
  // DTOs; this table reads keys generically, so both are read as plain records.
  const items = asItems(q.data) as Record<string, unknown>[];
  const cols = pickColumns(items);
  const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-muted";

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-500">
        {apiError(q.error, "Could not load — check that the controller is reachable and synced.")}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
          <Icon icon="heroicons-outline:calendar-days" className="text-xl" />
        </span>
        <h4 className="mb-1 text-sm font-semibold text-foreground">{SUB_TABS.find((t) => t.key === sub)?.label}</h4>
        <p className="max-w-sm text-xs text-muted">{COPY[sub]}</p>
        <p className="mt-2 max-w-sm text-[11px] text-muted/70">None reported by the controller.</p>
      </div>
    );
  }

  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-hover">
        <tr>
          {cols.map((c) => (
            <th key={c} className={th}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-card-border">
        {items.map((it, i) => (
          <tr key={rowKey(it, i)} className="hover:bg-hover/50">
            {cols.map((c) => (
              <td key={c} className="px-3 py-2 align-top font-mono text-[11px] text-muted">
                <Cell value={it[c]} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A row's React key: the DTO's own identifier when it has one, else the index. */
function rowKey(item: Record<string, unknown>, index: number): string {
  const id = item.UID ?? item.uid ?? item.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : String(index);
}

export interface ScheduledTabProps {
  instanceId: string;
}

export default function ScheduledTab({ instanceId }: ScheduledTabProps) {
  const [sub, setSub] = useState<ScheduledSub>("mags");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-card-border pb-3">
        <Icon icon="heroicons-outline:calendar-days" className="text-sm text-blue-500" />
        <span className="text-xs font-semibold text-foreground">Scheduled Access</span>
        <div className="ml-2 flex flex-wrap gap-1">
          {SUB_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSub(t.key)}
              className={`rounded-sm px-2 py-1 text-[11px] font-medium ${
                sub === t.key ? "bg-foreground text-background" : "bg-hover text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pt-2">
        <ScheduledList instanceId={instanceId} sub={sub} />
      </div>
    </div>
  );
}
