"use client";

// Situational stat header for the alarm monitor — four emphasis metric tiles
// (Critical open · Active · SLA breaching · Unassigned). Values are derived by the
// parent (from the /stats endpoint + the loaded page) and passed in as numbers so
// this stays presentational. Each tile is click-to-filter where it maps cleanly
// onto an existing filter (priority=critical, status=active).

import { Icon } from "@iconify/react";

function Tile({ icon, label, value, tone, active, onClick, hint }) {
  const tones = {
    red: "text-red-500 bg-red-500/10 border-red-500/25",
    blue: "text-blue-500 bg-blue-500/10 border-blue-500/25",
    amber: "text-amber-500 bg-amber-500/10 border-amber-500/25",
    slate: "text-muted bg-hover border-card-border",
  };
  const clickable = typeof onClick === "function";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      title={hint}
      className={`group relative flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
        active ? "border-foreground bg-hover" : "border-card-border hover:bg-hover"
      } ${clickable ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${tones[tone]}`}>
        <Icon icon={icon} className="text-lg" />
      </span>
      <span className="min-w-0">
        <span className="block text-2xl font-semibold leading-none text-foreground">{value}</span>
        <span className="mt-1 block truncate text-[11px] uppercase tracking-wide text-muted">{label}</span>
      </span>
    </button>
  );
}

export default function StatHeader({
  criticalOpen = 0,
  active = 0,
  slaBreaching = 0,
  unassigned = 0,
  activePriority,
  activeStatus,
  onPriority,
  onStatus,
}) {
  return (
    <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      <Tile
        icon="heroicons-solid:exclamation-triangle"
        label="Critical open"
        value={criticalOpen}
        tone="red"
        active={activePriority === "critical"}
        onClick={() => onPriority?.(activePriority === "critical" ? "" : "critical")}
        hint="Open incidents at critical priority — click to filter"
      />
      <Tile
        icon="heroicons-solid:signal"
        label="Active"
        value={active}
        tone="blue"
        active={activeStatus === "active"}
        onClick={() => onStatus?.(activeStatus === "active" ? "" : "active")}
        hint="Incidents currently active — click to filter"
      />
      <Tile
        icon="heroicons-solid:clock"
        label="SLA breaching"
        value={slaBreaching}
        tone="amber"
        hint="Open incidents past their SLA deadline (on this page)"
      />
      <Tile
        icon="heroicons-solid:user"
        label="Unassigned"
        value={unassigned}
        tone="slate"
        hint="Open incidents with no assignee (on this page)"
      />
    </div>
  );
}
