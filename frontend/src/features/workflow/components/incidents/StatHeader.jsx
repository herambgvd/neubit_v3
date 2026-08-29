"use client";

// Situational stat header for the alarm monitor — four emphasis metric tiles
// (Critical open · Active · SLA breaching · Unassigned). Values are derived by the
// parent (from the /stats endpoint + the loaded page) and passed in as numbers so
// this stays presentational. Each tile is click-to-filter where it maps cleanly
// onto an existing filter (priority=critical, status=active).

import { Icon } from "@iconify/react";

function Tile({ icon, label, value, tone, active, onClick, hint }) {
  const tones = {
    red: "text-[#fca5a5] bg-[rgba(248,113,113,.14)] border-[rgba(248,113,113,.45)]",
    blue: "text-[#93c5fd] bg-[rgba(96,165,250,.13)] border-[rgba(96,165,250,.4)]",
    amber: "text-[#fcd34d] bg-[rgba(251,191,36,.13)] border-[rgba(251,191,36,.4)]",
    slate: "text-[#aec2e8] bg-[rgba(150,180,245,.06)] border-[rgba(150,180,245,.22)]",
  };
  const clickable = typeof onClick === "function";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!clickable}
      title={hint}
      className={`group relative flex items-center gap-3 rounded-[13px] border px-4 py-3 text-left backdrop-blur-xs transition ${
        active
          ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.1)]"
          : "border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] hover:border-[rgba(34,211,238,.4)] hover:bg-[rgba(150,180,245,.07)]"
      } ${clickable ? "cursor-pointer" : "cursor-default"}`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[9px] border ${tones[tone]}`}>
        <Icon icon={icon} className="text-lg" />
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-2xl font-bold leading-none text-[#f2f6ff]">{value}</span>
        <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-[1.4px] text-[#7e93bf]">{label}</span>
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
