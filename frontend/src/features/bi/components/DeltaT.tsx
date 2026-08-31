"use client";

// ΔT — leaving water temperature minus entering water temperature.
//
// The first DERIVED value on this console: a number that is a function of TWO
// points rather than of one. It is computed by the SERVER, at query time, from
// the readings already stored — the `delta_t` measure on the `iot_readings`
// dataset (migration 0009). Nothing is written back to `readings`, and this
// component does no arithmetic of its own: it asks the one query API the same
// way a dashboard widget does, so the number on this screen and the number in a
// saved widget come out of the same generator and cannot disagree.
//
// WHY IT IS PINNED TO ONE DEVICE. The measure is declared incomparable across
// series and the backend refuses to aggregate it without a pin — no unit is on
// the wire, so nothing says the two tags are degrees of anything, and a mean ΔT
// across four chillers could be combining quantities that are not the same. The
// filter below is that pin, and it is why this panel is per-device rather than a
// fleet table.
//
// WHAT IS ABSENT, AND STAYS ABSENT:
//   • No unit. `points.unit` is empty for every point (contract §11/§12).
//   • No design ΔT and no threshold, so no red row and no "low ΔT" verdict. The
//     design figure is a property of the machine and it is in nobody's database
//     here; a threshold invented to make a row turn red is a diagnosis this
//     platform did not earn.
//   • No zero substituted for a missing side. A bucket where only one of the two
//     points reported has NO measured ΔT — and on this metric that matters more
//     than usual, because a ΔT near zero IS the fault being looked for. A
//     fabricated zero would read as a critical finding.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { LoadingBlock } from "@/components/console";
import { api } from "@/lib/api";

/** The two point tags the derived measure is defined over. Declared in the
 *  REGISTRY (the `delta_t` measure names them); repeated here only to decide
 *  whether the panel is relevant to the selected device, never to compute
 *  anything. */
export const DELTA_T_TAGS = ["OWT", "IWT"];

/** True when this device publishes both sides, so a ΔT is even askable. */
export function hasDeltaT(points: any[]): boolean {
  const tags = new Set((points || []).map((p: any) => p.point_tag));
  return DELTA_T_TAGS.every((t) => tags.has(t));
}

function fmt(v: any): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v.toFixed(1);
}

export default function DeltaT({ deviceId, deviceTag, hours, accent }: any) {
  const q = useQuery<any>({
    queryKey: ["bi-delta-t", deviceId, hours],
    enabled: !!deviceId,
    refetchInterval: 60_000,
    queryFn: () =>
      api
        .post("/bi/query", {
          spec_version: 2,
          viz: "table",
          query: {
            dataset: "iot_readings",
            window: { last_hours: hours },
            // Grouped by the device AND filtered to it: the group is what pins
            // the incomparable measure to one series, and the filter is what
            // keeps the query to one row.
            select: [
              { dimension: "device_tag" },
              { measure: "delta_t", aggregate: "last", alias: "latest" },
              { measure: "delta_t", aggregate: "avg", alias: "mean" },
            ],
            group_by: ["device_tag"],
            filters: [{ column: "device_id", op: "=", value: deviceId }],
            limit: 1,
          },
        })
        .then((r: any) => r.data),
  });

  const row = q.data?.rows?.[0];
  const latest = row?.[1];
  const mean = row?.[2];

  return (
    <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            ΔT · leaving − entering
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-nb-soft">
            OWT − IWT · {deviceTag}
          </div>
        </div>
        <Icon icon="heroicons:variable" className="text-base" style={{ color: accent }} />
      </div>

      {q.isLoading ? (
        <LoadingBlock label="Computing…" />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
              Latest
            </p>
            <p className="mt-1 font-mono text-[19px] leading-none text-nb-ink">{fmt(latest)}</p>
          </div>
          <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
              Mean · {hours}h
            </p>
            <p className="mt-1 font-mono text-[19px] leading-none text-nb-ink">{fmt(mean)}</p>
          </div>
        </div>
      )}

      <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
        {q.data?.resolution_reason ? `${q.data.resolution_reason}. ` : ""}
        Computed from the OWT and IWT readings at query time — never stored. No
        unit is shown because none is on the wire, and no design target or
        threshold is applied: nothing here knows what this machine was specified
        for. A bucket where only one side reported has no ΔT and shows an em dash
        rather than a zero.
      </p>
    </div>
  );
}
