"use client";

// Building Intelligence → PORTFOLIO. The estate overview across every category
// the gateway actually reports.
//
// Everything on this page is measured, not modelled. The counts come from the
// `points` dimension (one row per series, written by the reading-writer from a
// real reading — a point exists here only because it REPORTED), the ingest chart
// comes from the `readings_1h` continuous aggregate, and the freshness split
// comes from `points.last_seen_at`.
//
// What is deliberately NOT here:
//   • No unit on any number. `points.unit` is NULL for every point because the
//     source payloads carry none (contract §11/§12). A guessed "kW" would be
//     worse than a blank.
//   • No consumption, cost, carbon, efficiency or score. Nothing on the wire says
//     what a point measures, so every one of those would be fabricated.
//   • No IAQ / environment panel. There are ZERO environment points, so that tile
//     stays SOON in the launcher rather than being filled with something else.
//
// The WATER category has a console and a tile as of 2026-08-31. It was shown
// here before either existed — ten points on two devices are genuinely
// reporting, and hiding them would have misrepresented the estate — with no
// destination on its card, which was the honest state while there was nowhere to
// go. The card is a link now, from the one `href` in constants.ts.
//
// The "no console yet" caption is NOT dead code. `fire` still has none and must
// keep none: its single point has never produced a reading, so the category does
// not appear in `points` at all, and the caption is what a category earns by
// reporting without having a screen yet.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsolePage,
  ConsoleScroll,
  SectionCard,
  SectionHead,
  LoadingBlock,
  PanelStat,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import ActivityChart from "./components/ActivityChart";
import FaultQueue from "./components/FaultQueue";
import { bi } from "./api";
import { categoryMeta, deviceTypeLabel } from "./constants";

// The fault window. 24 hours matches the ingest chart beside it; the server caps
// this endpoint at 48 because it reads the raw alert table.
const ALERT_HOURS = 24;

function Metric({ label, value, sub, tone = "text-nb-ink" }: any) {
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{label}</p>
      <p className={`mt-1 font-mono text-[19px] leading-none ${tone}`}>{value}</p>
      {sub && <p className="mt-1 text-[11px] text-nb-faint">{sub}</p>}
    </div>
  );
}

function CategoryCard({ row }: any) {
  const meta = categoryMeta(row.category);
  const quiet = row.points - row.points_reporting;
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className="grid h-8 w-8 place-items-center rounded-[9px] border"
            style={{ borderColor: `${meta.accent}55`, background: `${meta.accent}18`, color: meta.accent }}
          >
            <Icon icon={meta.icon} className="text-base" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-semibold text-nb-ink">{meta.label}</div>
            <div className="font-mono text-[11px] text-nb-faint">{row.category ?? "no category on the wire"}</div>
          </div>
        </div>
        {meta.href ? (
          <Icon icon="heroicons:arrow-up-right" className="mt-1 shrink-0 text-sm text-nb-faint" />
        ) : null}
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <div className="font-mono text-[17px] leading-none text-nb-ink">{row.devices}</div>
          <div className="mt-1 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">devices</div>
        </div>
        <div>
          <div className="font-mono text-[17px] leading-none text-nb-ink">{row.points}</div>
          <div className="mt-1 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">points</div>
        </div>
        <div>
          <div
            className={`font-mono text-[17px] leading-none ${quiet ? "text-nb-warn" : "text-nb-good"}`}
          >
            {quiet ? quiet : "0"}
          </div>
          <div className="mt-1 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">quiet</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {row.device_types.map((t: any) => (
          <span
            key={`${t.device_type}`}
            className="rounded-[6px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-0.5 text-[10.5px] text-nb-soft"
          >
            {deviceTypeLabel(t.device_type)}
            <span className="ml-1 font-mono text-nb-faint">{t.devices}</span>
          </span>
        ))}
      </div>

      <div className="mt-3 border-t border-nb-line/50 pt-2 text-[11px] text-nb-faint">
        last reading {fmtRelative(row.last_seen_at)}
        {!meta.href && (
          <span className="ml-2 rounded-[5px] border border-nb-line px-1.5 py-0.5 text-[10px] uppercase tracking-[1.1px] text-nb-faint">
            no console yet
          </span>
        )}
      </div>
    </>
  );

  const cls =
    "block rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-3.5 transition";

  return meta.href ? (
    <Link href={meta.href} className={`${cls} hover:border-nb-blue/60 hover:bg-white/[.03]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default function Portfolio() {
  const summaryQ = useQuery<any>({
    queryKey: ["bi-summary"],
    queryFn: () => bi.summary(),
    refetchInterval: 30_000,
  });
  const activityQ = useQuery<any>({
    queryKey: ["bi-activity", 24],
    queryFn: () => bi.activity(24),
    refetchInterval: 60_000,
  });
  // The fault queue. Same 24-hour window as the ingest chart, so the two panels
  // answer about the same stretch of time rather than quietly disagreeing.
  const alertsQ = useQuery<any>({
    queryKey: ["bi-alerts", ALERT_HOURS],
    queryFn: () => bi.alerts({ hours: ALERT_HOURS, limit: 50 }),
    refetchInterval: 30_000,
  });

  const s = summaryQ.data;
  const err = summaryQ.error ? apiError(summaryQ.error, "Could not load the reading store") : null;

  return (
    <ConsolePage>
      <ConsoleScroll>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[17px] font-semibold text-nb-ink">Portfolio</h1>
            <p className="mt-0.5 text-[11.5px] text-nb-faint">
              Every device and measurement point that has reported into the reading store, by
              category. Counts are of what has REPORTED — a device appears here because a
              reading arrived, not because something was configured.
            </p>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-nb-faint">
            {summaryQ.isFetching && (
              <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" />
            )}
            {s && <span>updated {fmtRelative(s.generated_at)}</span>}
          </div>
        </div>

        {err ? (
          <SectionCard className="text-center text-xs text-nb-crit">{err}</SectionCard>
        ) : summaryQ.isLoading ? (
          <LoadingBlock label="Reading the store…" />
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
            <div className="min-w-0 space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Devices" value={s.total_devices} sub="reporting into the store" />
                <Metric label="Points" value={s.total_points} sub="distinct series" />
                <Metric
                  label="Reporting"
                  value={s.total_points_reporting}
                  sub={`seen in the last ${s.fresh_minutes} min`}
                  tone={
                    s.total_points_reporting === s.total_points ? "text-nb-good" : "text-nb-warn"
                  }
                />
                <Metric
                  label="Samples this hour"
                  value={s.readings_last_hour.toLocaleString()}
                  sub="from readings_1h"
                />
              </div>

              <SectionCard>
                <SectionHead
                  icon="heroicons:bell-alert"
                  title={`Live queue \u2014 faults raised in the last ${ALERT_HOURS} hours`}
                  desc="Alerts the gateway itself raised, projected onto the reporting store. Severity, type, device and wording are the gateway's; nothing here is inferred. It is deliberately NOT labelled cross-domain: an alert carries no device category, so it cannot be attributed to energy or HVAC without inventing the attribution."
                />
                <FaultQueue query={alertsQ} hours={ALERT_HOURS} />
              </SectionCard>

              <SectionCard>
                <SectionHead
                  icon="heroicons:chart-bar"
                  title="Ingest — last 24 hours"
                  desc="Samples per hour, stacked by category, read from the readings_1h continuous aggregate. This counts samples, not a physical quantity: the source payloads carry no unit, so nothing here is converted into one."
                />
                {activityQ.isLoading ? (
                  <LoadingBlock label="Loading rollup…" />
                ) : (
                  <ActivityChart rows={activityQ.data || []} />
                )}
              </SectionCard>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {s.categories.map((row: any) => (
                  <CategoryCard key={row.category ?? "_none"} row={row} />
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <SectionCard>
                <SectionHead icon="heroicons:clock" title="Store" />
                <PanelStat label="First reading" value={fmtRelative(s.first_reading_at)} />
                <PanelStat label="Last reading" value={fmtRelative(s.last_reading_at)} tone="good" />
                <PanelStat label="Categories reporting" value={s.categories.filter((c: any) => c.category).length} />
                <PanelStat
                  label="Unclassified points"
                  value={s.categories.find((c: any) => !c.category)?.points ?? 0}
                  tone="faint"
                />
              </SectionCard>

              <SectionCard>
                <SectionHead
                  icon="heroicons:map"
                  title="Floor-wise"
                  desc="Where the estate is anchored. A point with no floor counts as UNPLACED and is shown as one — never folded into a floor it was not placed on. Placement is a device-level statement made on the Placement screen; nothing is ever inferred from a device tag."
                />
                {s.placement ? (
                  <>
                    <PanelStat
                      label="Placed on a floor"
                      value={`${s.placement.with_floor} of ${s.placement.points}`}
                      tone={s.placement.with_floor ? "good" : "faint"}
                    />
                    <PanelStat
                      label="Placed on a site"
                      value={`${s.placement.with_site} of ${s.placement.points}`}
                      tone={s.placement.with_site ? "good" : "faint"}
                    />
                    <PanelStat
                      label="Unplaced"
                      value={s.placement.unplaced}
                      tone={s.placement.unplaced ? "warn" : "good"}
                    />
                  </>
                ) : null}
                <ul className="mt-2 space-y-1.5">
                  {(s.floors || []).map((f: any) => (
                    <li
                      key={f.floor_id ?? "_unplaced"}
                      className="flex items-center justify-between gap-2 text-[11.5px]"
                    >
                      <span className={f.floor_id ? "text-nb-soft" : "text-nb-faint italic"}>
                        {f.floor_name || (f.floor_id ? f.floor_id : "Unplaced")}
                        {f.site_name ? (
                          <span className="ml-1 text-nb-faint">· {f.site_name}</span>
                        ) : null}
                      </span>
                      <span className="font-mono text-nb-ink">{f.points}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 border-t border-nb-line/50 pt-2">
                  <p className="text-[11px] leading-relaxed text-nb-faint">
                    No placement is inferred. The gateway wire carries none, and a
                    floor parsed out of a device tag would be right for most of an
                    estate and silently wrong for the rest — which is worse than
                    “unplaced”. An operator places a DEVICE and its points follow.
                  </p>
                  <Link
                    href="/bi/placement"
                    className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-nb-blueb hover:underline"
                  >
                    <Icon icon="heroicons:map-pin" className="text-sm" />
                    Place devices
                  </Link>
                </div>
              </SectionCard>

              <SectionCard>
                <SectionHead
                  icon="heroicons:information-circle"
                  title="What is not here"
                  desc="Stated rather than hidden, so a blank panel is never mistaken for a broken one."
                />
                <ul className="space-y-2 text-[11.5px] leading-relaxed text-nb-faint">
                  <li>
                    <span className="text-nb-soft">No units.</span> Every point reports its value
                    with an empty unit, so none is shown. Inferring one from a tag would put a
                    number on screen that nobody measured.
                  </li>
                  <li>
                    <span className="text-nb-soft">No IAQ &amp; Environment.</span> Zero environment
                    points exist in the store, so that surface stays unbuilt rather than filled
                    with a stand-in.
                  </li>
                  <li>
                    <span className="text-nb-soft">No consumption or cost.</span> Deriving kWh or a
                    tariff needs to know what a point measures; the wire does not say.
                  </li>
                </ul>
              </SectionCard>
            </div>
          </div>
        )}
      </ConsoleScroll>
    </ConsolePage>
  );
}
