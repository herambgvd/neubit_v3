"use client";

// Clickable stat tiles (counts by status/category). Used by the incident list;
// reusable for notifications, audit, any list with a summary + filter-by-tile.
//
//   <StatsStrip
//     stats={[{key:"", label:"Total", count:42}, {key:"active", label:"Active", count:5}]}
//     active={status} onSelect={setStatus} />

import type { ReactNode } from "react";

export interface StatItem<K extends string = string> {
  key: K;
  label: ReactNode;
  count?: number | null;
  /** A text-colour class for the count (e.g. "text-nb-crit"). */
  color?: string;
}

export interface StatsStripProps<K extends string = string> {
  stats?: StatItem<K>[];
  active?: K | null;
  /** NoInfer: `K` is fixed by `stats`/`active`, not by a setState handler. */
  onSelect?: (key: NoInfer<K>) => void;
  className?: string;
}

export function StatsStrip<K extends string = string>({ stats = [], active, onSelect, className = "" }: StatsStripProps<K>) {
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6 ${className}`}>
      {stats.map((s) => {
        const isActive = active === s.key;
        return (
          <button
            key={s.key || "all"}
            type="button"
            onClick={() => onSelect?.(s.key)}
            className={`rounded-xl border px-3 py-2.5 text-left transition ${
              isActive ? "border-nb-teal bg-nb-teal/10" : "border-nb-line bg-[rgba(8,15,34,.5)] hover:bg-white/5"
            }`}
          >
            <div className={`text-lg font-semibold ${s.color || "text-nb-ink"}`}>{s.count ?? 0}</div>
            <div className="text-[11px] text-nb-muted">{s.label}</div>
          </button>
        );
      })}
    </div>
  );
}

export default StatsStrip;
