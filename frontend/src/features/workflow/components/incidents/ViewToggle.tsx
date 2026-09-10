"use client";

// Bento / Map view switch — a two-segment control at the top of the alarm queue.
// Controlled: parent owns `view` ("board" | "map") and the setter.
//
// The key stays "board" because it is what the parent's state and every caller
// already say; the LABEL is what an operator reads, and there has not been a
// board on this screen since the bento replaced it.

import { Icon } from "@iconify/react";

export type IncidentView = "board" | "map";

const OPTS: { key: IncidentView; label: string; icon: string }[] = [
  { key: "board", label: "Bento", icon: "heroicons-outline:squares-2x2" },
  { key: "map", label: "Map", icon: "heroicons-outline:map" },
];

export interface ViewToggleProps {
  view?: IncidentView;
  onChange?: (view: IncidentView) => void;
}

export default function ViewToggle({ view = "board", onChange }: ViewToggleProps) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.55)] p-0.5">
      {OPTS.map((o) => {
        const active = view === o.key;
        return (
          <button
            key={o.key}
            type="button"
            onClick={() => onChange?.(o.key)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11.5px] font-medium transition ${
              active
                ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                : "text-[#7e93bf] hover:text-[#aec2e8]"
            }`}
          >
            <Icon icon={o.icon} className="text-xs" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
