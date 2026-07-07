"use client";

// A single site row in the master list (left pane). Shows thumbnail/status dot,
// name + type pill, city, and location code. Selection highlight + click handled
// by the parent Sites orchestrator.
import { Icon } from "@iconify/react";
import { fileUrl } from "@/lib/api";

export default function SiteListItem({ site, selected, onSelect }) {
  const s = site;
  const city = [s.address?.city, s.address?.state].filter(Boolean).join(", ");
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
          selected ? "bg-hover" : "hover:bg-hover"
        }`}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-md bg-hover text-muted shrink-0 overflow-hidden border border-card-border">
          {s.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(s.image_url)} alt={s.name} className="h-full w-full object-cover" />
          ) : (
            <Icon icon="heroicons-outline:map-pin" className="text-base" />
          )}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${
              s.is_active !== false ? "bg-green-500" : "bg-muted/50"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{s.name}</span>
            {s.site_type && (
              <span className="text-[10px] rounded-full bg-blue-500/10 text-blue-500 px-1.5 py-0.5 font-medium capitalize">
                {s.site_type}
              </span>
            )}
          </span>
          {city && <span className="block text-xs text-muted truncate">{city}</span>}
          {s.location_code && (
            <span className="block text-[10px] font-mono text-muted/70 truncate">{s.location_code}</span>
          )}
        </span>
      </button>
    </li>
  );
}
