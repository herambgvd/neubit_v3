"use client";

// The view switch at the top of the alarm queue — two icons, no words.
//
// It sits in a 19rem rail above a search box and a filter row; "Bento" and "Map"
// spelled out took a third of that line to name two things an icon says at a
// glance. The words survive as the accessible name and the tooltip, so nothing is
// lost to anybody reading with a screen reader or hovering to check.

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
            title={o.label}
            aria-label={o.label}
            className={`inline-flex h-6 w-7 items-center justify-center rounded-[6px] transition ${
              active
                ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                : "text-[#7e93bf] hover:text-[#aec2e8]"
            }`}
          >
            <Icon icon={o.icon} className="text-sm" />
          </button>
        );
      })}
    </div>
  );
}
