"use client";

// Google Maps info-window content for a selected site. Renders inside Google's own
// light popup, so this card keeps explicit light colors rather than theme tokens.
// The title needs `!` — the app is locked to dark mode and the global
// `h3 { …dark:text-slate-300 }` rule in _typography.scss outranks a plain class,
// which washed the site name out to grey on the white popup.
import { Icon } from "@iconify/react";

import type { SitePublic } from "@/lib/types";
import { THREAT_PIN } from "../constants";
import type { SiteOps } from "../estateRollup";

export interface SiteCardProps {
  site: SitePublic;
  /** The site's live rollup. Absent while the feeds load — the card then shows
   *  what it knows rather than zeros, which would read as "nothing here". */
  ops?: SiteOps;
  onClose?: () => void;
}

export default function SiteCard({ site, ops, onClose }: SiteCardProps) {
  const tone = THREAT_PIN[site.threat_level] || THREAT_PIN.normal;
  return (
    <div className="relative min-w-[240px] max-w-[280px] space-y-2 rounded-lg border border-slate-200 bg-white p-2 text-slate-800">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900"
      >
        <Icon icon="heroicons-outline:x-mark" className="text-sm" />
      </button>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-white" style={{ backgroundColor: tone.color }}>
          <Icon icon="heroicons-outline:building-office-2" className="text-base" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold !text-slate-900">{site.name}</h3>
          {site.location_code && <p className="font-mono text-[10px] text-slate-500">{site.location_code}</p>}
        </div>
      </div>
      <div className="space-y-1 rounded-md bg-slate-50 p-2 text-[11px] text-slate-700">
        <div className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: tone.color }} />
          <span>Threat: <strong>{tone.label}</strong></span>
        </div>
        {site.address?.city && (
          <div className="flex items-center gap-1.5">
            <Icon icon="heroicons-outline:map-pin" className="text-slate-500 text-xs" />
            <span>{[site.address.city, site.address.state, site.address.country].filter(Boolean).join(", ")}</span>
          </div>
        )}
      </div>
      {ops && (
        <div className="grid grid-cols-3 gap-1 text-center">
          {[
            { label: "Cameras", value: ops.cameras, tone: "text-slate-800" },
            { label: "Offline", value: ops.offline, tone: ops.offline ? "text-amber-600" : "text-slate-400" },
            { label: "Alarms", value: ops.alarms, tone: ops.alarms ? "text-red-600" : "text-slate-400" },
          ].map((s) => (
            <div key={s.label} className="rounded-md border border-slate-200 py-1">
              <div className={`text-sm font-semibold ${s.tone}`}>{s.value}</div>
              <div className="text-[9.5px] uppercase tracking-wide text-slate-500">{s.label}</div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        {/* The drill-down the map existed without: an outdoor pin and the indoor
            floor plan were two maps with no way from one to the other. */}
        <a
          href={`/streaming?view=map&site=${encodeURIComponent(site.site_id)}`}
          className="inline-flex items-center gap-1 rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
        >
          Floor plan
          <Icon icon="heroicons-outline:map" className="text-[10px]" />
        </a>
        <a
          href="/sites"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-sm border border-slate-300 px-2 py-1 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
        >
          Configure
          <Icon icon="heroicons-outline:arrow-top-right-on-square" className="text-[10px]" />
        </a>
      </div>
    </div>
  );
}
