"use client";

// Incident list summary tiles — one "Total" tile + one per status, click-to-filter.
// Wraps the shared StatsStrip: builds the tile list from the raw `statusCounts`
// object (the /stats endpoint shape) and the current filtered total.
import { StatsStrip } from "@/components/common";
import { titleize } from "@/lib/format";
import { INCIDENT_STATUSES } from "../../constants";

export default function IncidentStatsStrip({ statusCounts, total, active, onSelect }) {
  if (!statusCounts) return null;

  const stats = [
    { key: "", label: "Total", count: statusCounts.total ?? total },
    ...INCIDENT_STATUSES.map((s) => ({
      key: s,
      label: titleize(s),
      count: Number(statusCounts[s]) || 0,
    })),
  ];

  return <StatsStrip stats={stats} active={active} onSelect={onSelect} className="mb-4" />;
}
