"use client";

// Per-widget REFRESH interval.
//
// PORTED in substance from the reference's `widget-refresh-cache.tsx` (156
// lines): a preset list plus "inherit" and "off", stored on the widget's options.
//
// WHAT IS NOT HERE, AND WHY
// -------------------------
// Their "cache results for N seconds" field is dropped. It sets a server-side TTL
// on a cached query result, and on this platform that would be a second, silent
// answer to a question the executor already answers honestly: every result
// carries `resolution` and `resolution_reason` saying which store replied and
// what that means for freshness. A cache TTL layered on top means a tile can
// print "1-minute rollup, real-time" over a number that is five minutes old —
// which is exactly the kind of quiet precision claim contract §4 exists to stop.
// If caching is ever needed it belongs in the executor, where it can amend the
// reason line.
//
// So this component sets ONE thing: how often the browser re-reads. The floor is
// deliberate — the building publishes on a ~5 minute cycle, so a 5-second poll
// would be twelve requests per widget per publish, all returning the same rows.

import { Icon } from "@iconify/react";

import { Select } from "@/components/ui/kit";

/** Presets, in seconds. `0` means "do not poll"; absent means "inherit". */
export const REFRESH_PRESETS = [15, 30, 60, 300, 900];

/** The dashboard-wide default, in ms. The building publishes on a ~5 minute
 *  cycle, so a minute is comfortably inside it without turning a 20-widget page
 *  into a steady stream of requests. */
export const DEFAULT_REFRESH_MS = 60_000;

/** A widget's refresh interval in ms, from its options. `0` disables polling. */
export function refreshMsFor(options?: Record<string, any> | null): number {
  const secs = options?.refresh_sec;
  if (secs === undefined || secs === null) return DEFAULT_REFRESH_MS;
  const n = Number(secs);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REFRESH_MS;
  if (n === 0) return 0;
  // Floored, not honoured blindly: a 1-second poll on a store that publishes
  // every five minutes is load with no information in it.
  return Math.max(15, n) * 1000;
}

export default function WidgetRefresh({
  options,
  onChange,
}: {
  options: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
}) {
  const value = options?.refresh_sec;
  const current = value === undefined || value === null ? "" : String(value);

  const set = (raw: string) => {
    const opts = { ...(options || {}) };
    if (raw === "") delete opts.refresh_sec;
    else opts.refresh_sec = Number(raw);
    onChange(opts);
  };

  return (
    <div className="space-y-1.5">
      <Select
        label="Refresh"
        hint="how often this widget re-reads the store"
        value={current}
        onChange={(e: any) => set(e.target.value)}
        options={[
          { value: "", label: `Dashboard default (${DEFAULT_REFRESH_MS / 1000}s)` },
          { value: "0", label: "Do not refresh" },
          ...REFRESH_PRESETS.map((s) => ({
            value: String(s),
            label: s >= 60 ? `Every ${s / 60} min` : `Every ${s}s`,
          })),
        ]}
      />
      <p className="flex gap-1.5 text-[10.5px] leading-snug text-nb-faint">
        <Icon icon="heroicons:information-circle" className="mt-[1px] shrink-0 text-[12px]" />
        <span>
          Polling faster than the store publishes does not make a number fresher.
          Whichever interval you pick, the tile keeps printing which store answered
          and how current that store is — that line, not this setting, is what
          says how old the number is.
        </span>
      </p>
    </div>
  );
}
