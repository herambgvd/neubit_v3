"use client";

// ΔT — leaving water temperature minus entering water temperature.
//
// READS THE METRIC REGISTRY. This panel asks `/bi/metrics/evaluate` for the
// `chiller_delta_t` definition (a ROW in `metric_definitions`, contract §20),
// pinned to one device. The registry binds the two sides through CONFIRMED
// point roles (outlet_water_temp / inlet_water_temp) and computes only when
// every guard holds: roles present, units operator-confirmed, same unit, and
// non-frozen inputs. Fixture parity with the retired dataset measure was
// proven to 1e-12 before the swap (contract §21), and the dead `delta_t`
// dataset measure was then removed — one definition of ΔT exists now.
//
// WHAT A REFUSAL LOOKS LIKE, AND WHY IT RENDERS. A frozen chiller (all of the
// York/Khem02 fleet today) does not show 0.0 or an empty box: the server
// answers `{status: "undefined_frozen", reason: …}` naming the flat input, and
// this component prints that verbatim. On this metric that discipline matters
// more than usual — a ΔT near zero IS the fault being looked for, so a
// fabricated number would read as a critical diagnosis nobody made.
//
// THE SIGN IS CORRECT. ΔT here is leaving − entering; chilled water leaves
// COLDER than it returns, so a healthy chiller shows a NEGATIVE ΔT. Nothing
// flips the sign to look prettier.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { LoadingBlock } from "@/components/console";

import { metrics } from "../metricsApi";

/** The metric this panel evaluates. The definition itself — formula, roles,
 *  guards, display — lives in the registry as data; this is only its key. */
export const DELTA_T_METRIC = "chiller_delta_t";

/** The two point tags this estate publishes the sides under. Used only to
 *  decide whether the panel is RELEVANT to the selected device — the actual
 *  binding goes through confirmed point roles, never through these strings. */
export const DELTA_T_TAGS = ["OWT", "IWT"];

/** True when this device publishes both sides, so a ΔT is even askable. */
export function hasDeltaT(points: any[]): boolean {
  const tags = new Set((points || []).map((p: any) => p.point_tag));
  return DELTA_T_TAGS.every((t) => tags.has(t));
}

function fmt(v: any, precision = 1): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v.toFixed(precision);
}

/** Human labels for the evaluator's refusal statuses (contract §20). The
 *  server's `reason` is the substance; this is just the headline. */
const STATUS_LABEL: Record<string, string> = {
  missing_role: "No confirmed role",
  ambiguous_role: "Ambiguous role",
  unit_unconfirmed: "Unit not confirmed",
  unit_mismatch: "Unit mismatch",
  no_data: "No data in window",
  undefined_frozen: "Undefined — input frozen",
  blocked: "Blocked",
};

export default function DeltaT({ deviceId, deviceTag, hours, accent }: any) {
  const q = useQuery<any>({
    queryKey: ["bi-metric-delta-t", deviceId, hours],
    enabled: !!deviceId,
    refetchInterval: 60_000,
    queryFn: () =>
      metrics.evaluate({ metric: DELTA_T_METRIC, device_id: deviceId, hours }),
  });

  const item = q.data?.items?.[0];
  const ok = item?.status === "ok";
  const precision = q.data?.display?.precision ?? 1;
  const unit = ok && item.unit ? ` ${item.unit}` : "";
  // Mean over the window is the evaluation's own value; "latest" is the last
  // aligned bucket of the per-bucket series the server returns beside it.
  const series = ok ? item.series || [] : [];
  const latest = series.length ? series[series.length - 1]?.value : undefined;

  return (
    <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
            ΔT · leaving − entering
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-nb-soft">
            {q.data?.formula || "owt − iwt"} · {deviceTag}
            {q.data?.version ? ` · registry v${q.data.version}` : ""}
          </div>
        </div>
        <Icon icon="heroicons:variable" className="text-base" style={{ color: accent }} />
      </div>

      {q.isLoading ? (
        <LoadingBlock label="Evaluating…" />
      ) : !item ? (
        <p className="text-[11.5px] leading-relaxed text-nb-faint">
          The registry returned no evaluation for this device.
        </p>
      ) : ok ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
                Latest bucket
              </p>
              <p className="mt-1 font-mono text-[19px] leading-none text-nb-ink">
                {fmt(latest, precision)}
                {latest !== undefined && unit ? (
                  <span className="text-[11px] text-nb-muted">{unit}</span>
                ) : null}
              </p>
            </div>
            <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
                Mean · {hours}h
              </p>
              <p className="mt-1 font-mono text-[19px] leading-none text-nb-ink">
                {fmt(item.value, precision)}
                {unit ? <span className="text-[11px] text-nb-muted">{unit}</span> : null}
              </p>
            </div>
          </div>
          <p className="mt-2 break-all font-mono text-[10px] leading-relaxed text-nb-faint">
            {item.arithmetic}
          </p>
        </>
      ) : (
        <div className="rounded-[10px] border border-dashed border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
          <p className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-amber-300/80">
            {STATUS_LABEL[item.status] || item.status}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-nb-soft">{item.reason}</p>
        </div>
      )}

      <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
        {q.data?.resolution_reason ? `${q.data.resolution_reason}. ` : ""}
        Evaluated by the metric registry from operator-confirmed roles and units
        — never from tag names, never stored. Negative is the correct sign:
        chilled water leaves colder than it returns. A guard that fails renders
        its reason here, never a zero.
      </p>
    </div>
  );
}
