"use client";

// Board / Map view switch — a two-segment control for the alarm monitor header.
// Controlled: parent owns `view` ("board" | "map") and the setter.

import { Icon } from "@iconify/react";

const OPTS = [
  { key: "board", label: "Board", icon: "heroicons-outline:squares-2x2" },
  { key: "map", label: "Map", icon: "heroicons-outline:map" },
];

export default function ViewToggle({ view = "board", onChange }: any) {
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
            className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-sm font-medium transition ${
              active
                ? "bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
                : "text-[#7e93bf] hover:text-[#aec2e8]"
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
