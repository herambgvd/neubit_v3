"use client";

// Board / Map view switch — a two-segment control for the alarm monitor header.
// Controlled: parent owns `view` ("board" | "map") and the setter.

import { Icon } from "@iconify/react";

const OPTS = [
  { key: "board", label: "Board", icon: "heroicons-outline:squares-2x2" },
  { key: "map", label: "Map", icon: "heroicons-outline:map" },
];

export default function ViewToggle({ view = "board", onChange }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-card-border bg-card p-0.5">
      {OPTS.map((o) => {
        const active = view === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange?.(o.key)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition ${
              active ? "bg-hover text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            <Icon icon={o.icon} className="text-base" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
