"use client";

// Scheduled Access. Ported from neubit_v2's scheduled-tab.jsx — SAME sub-tab shell
// (Scheduled MAGs / Scheduled Readers / Weekly Programs) so the surface matches v2.
//
// IMPORTANT (v3): the v3 access service does NOT yet expose the scheduled-mags,
// scheduled-readers or weekly-programs endpoints (the verified v3 contract covers
// instances/cardholders/cards/access-groups/schedules/doors/commands/hardware/
// events/sync-jobs only). So each sub-tab renders a faithful "not available in this
// build" placeholder rather than calling a non-existent endpoint. When the backend
// lands these routes, wire them here (add the calls to features/access/api.js).
import { useState } from "react";
import { Icon } from "@iconify/react";

const SUB_TABS = [
  { key: "mags", label: "Scheduled MAGs" },
  { key: "readers", label: "Scheduled Readers" },
  { key: "weekly", label: "Weekly Programs" },
];

const COPY = {
  mags: "Temporary cardholder → security-group grants between two dates.",
  readers: "Per-reader scheduled weekly-program assignments.",
  weekly: "The read-only weekly-program inventory pulled from the controller.",
};

export default function ScheduledTab() {
  const [sub, setSub] = useState("mags");

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
              className={`rounded px-2 py-1 text-[11px] font-medium ${
                sub === t.key ? "bg-foreground text-background" : "bg-hover text-muted hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pt-2">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <span className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
            <Icon icon="heroicons-outline:calendar-days" className="text-xl" />
          </span>
          <h4 className="mb-1 text-sm font-semibold text-foreground">{SUB_TABS.find((t) => t.key === sub)?.label}</h4>
          <p className="max-w-sm text-xs text-muted">{COPY[sub]}</p>
          <p className="mt-2 max-w-sm text-[11px] text-muted/70">
            Not yet exposed by the v3 access service — this surface is ready to wire once the
            scheduled-access endpoints ship.
          </p>
        </div>
      </div>
    </div>
  );
}
