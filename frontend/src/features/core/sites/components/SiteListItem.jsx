"use client";

// A single site card in the left library (matches the Users list style): thumbnail
// or map-pin, name + type pill, city sub-line, and an active-status dot.
import { Icon } from "@iconify/react";
import { fileUrl } from "@/lib/api";

export default function SiteListItem({ site, selected, onSelect }) {
  const s = site;
  const city = [s.address?.city, s.address?.state].filter(Boolean).join(", ");
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-[rgba(96,165,250,.6)] bg-[rgba(96,165,250,.1)]"
          : "border-nb-line bg-[rgba(6,11,26,.5)] hover:border-[rgba(150,180,245,.42)]"
      }`}
    >
      <span className="relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[9px] border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
        {s.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(s.image_url)} alt={s.name} className="h-full w-full object-cover" />
        ) : (
          <Icon icon="heroicons-outline:map-pin" className="text-base text-nb-blueb" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-nb-ink">{s.name}</span>
          {s.site_type && (
            <span className="rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-1.5 py-px text-[9px] font-medium capitalize text-nb-blueb">
              {s.site_type}
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-nb-faint">
          {city || s.location_code || "—"}
        </span>
      </span>
      <span className={`h-2 w-2 shrink-0 rounded-full ${s.is_active !== false ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"}`} />
    </button>
  );
}
