"use client";

// A single tag row in the master list (left pane). Mirrors SiteListItem's shape:
// color tile + active dot, name + usage pill, description, hex code. Selection
// highlight + click handled by the parent Tags orchestrator.
import { Icon } from "@iconify/react";

import { DEFAULT_COLOR } from "../constants";

export default function TagListItem({ tag, selected, onSelect }) {
  const t = tag;
  const color = t.color || DEFAULT_COLOR;
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
          selected ? "bg-hover" : "hover:bg-hover"
        }`}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-md shrink-0 text-white border border-card-border" style={{ background: color }}>
          <Icon icon="heroicons:tag" className="text-base" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${
              t.is_active !== false ? "bg-green-500" : "bg-muted/50"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{t.name}</span>
            {typeof t.usage_count === "number" && t.usage_count > 0 && (
              <span className="text-[10px] rounded-full bg-blue-500/10 text-blue-500 px-1.5 py-0.5 font-medium shrink-0">
                {t.usage_count} use{t.usage_count === 1 ? "" : "s"}
              </span>
            )}
          </span>
          {t.description && <span className="block text-xs text-muted truncate">{t.description}</span>}
          <span className="block text-[10px] font-mono text-muted/70 truncate">{color.toUpperCase()}</span>
        </span>
      </button>
    </li>
  );
}
