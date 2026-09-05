"use client";

// Building Intelligence → PORTFOLIO. The estate overview across every category
// the gateway actually reports — on the estate SKELETON (components/console/
// estate.tsx): 5-slot KPI strip, two-column main with the site leaderboard on
// the left and the charts + fault queue on the right. The shape is the
// neubit-vms-bi mockup's; every number in it is measured, and the mockup's
// invented figures (a CCEI, a savings figure, a carbon tonnage) are NOT
// reproduced — a slot whose input does not exist renders "—" with the reason.
//
// Everything on this page is measured, not modelled. The counts come from the
// `points` dimension (one row per series, written by the reading-writer from a
// real reading — a point exists here only because it REPORTED), the ingest chart
// comes from the `readings_1h` continuous aggregate, and the freshness split
// comes from `points.last_seen_at`.
//
// The LEADERBOARD's row set is `site_facts` (core's sites, mirrored) plus the
// UNPLACED pseudo-row — a real state, never folded into a site. Per row:
//   • score      — reads the API's `score` field, which is NULL until the
//                  metric registry defines one. The dash is the SLOT rendering
//                  a null, not a hardcoded dash.
//   • area/city  — the mirror's facts; NULL is NOT RECORDED and renders "—".
//   • chips      — per-category device/point counts, 24h critical alerts
//                  (attributed through the device's placement), measured kWh
//                  (blocked until an operator confirms units in Ratings).
//   • trend      — "—": no score history exists, because no score exists.
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
// THE PAGE NO LONGER EXPLAINS ITSELF ON SCREEN, and that is a deliberate trade.
// It used to carry a standfirst, a "What is not here" panel and a paragraph
// under Floor-wise — together more prose than data, which buried the numbers
// they were meant to qualify. Those reasons did not stop being true, so they
// live HERE, where the next person to change this file reads them, instead of
// in front of an operator who reads the same four paragraphs every morning.
//
// The rule that survives ON screen is the one that cannot be moved: a slot with
// no honest input renders "—" and carries its reason in the row or the tooltip
// beside it, never a zero and never a guess. A short label is fine; a silent
// fabrication is not.
//
// Floor-wise was removed with its panel. The placement facts it showed are not
// lost — the leaderboard's UNPLACED pseudo-row is the same statement, on the
// surface where a site is already being read, and pinning still happens in
// Configurations → Sites.
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
  SectionCard,
  SectionHead,
  LoadingBlock,
  KpiStrip,
  Kpi,
  Leaderboard,
  LeaderRow,
  LeaderChip,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import ActivityChart from "./components/ActivityChart";
import FaultQueue, { FaultSeverity } from "./components/FaultQueue";
import { bi } from "./api";
import { categoryMeta, deviceTypeLabel } from "./constants";

// The fault window. 24 hours matches the ingest chart beside it; the server caps
// this endpoint at 48 because it reads the raw alert table.
const ALERT_HOURS = 24;

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

      {/* one line, scrolled — NOT wrapped. A wrapping chip list makes the card
          as tall as the estate's messiest category, and every other card in the
          row grows to match it. */}
      <div className="mt-3 flex gap-1.5 overflow-x-auto pb-0.5">
        {row.device_types.map((t: any) => (
          <span
            key={`${t.device_type}`}
            className="shrink-0 rounded-[6px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2 py-0.5 text-[10.5px] text-nb-soft"
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

  // `flex-1` so the strip SPANS the page rather than huddling at its left, with
  // a floor low enough that the three stats and the label still read. Past the
  // point where every card is at its floor the strip scrolls sideways instead of
  // squeezing them into unreadable slivers.
  const cls =
    "block min-w-[212px] flex-1 rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-3.5 transition";

  return meta.href ? (
    <Link href={meta.href} className={`${cls} hover:border-nb-blue/60 hover:bg-white/[.03]`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** One site of the estate (or the unplaced pseudo-row) on the shared LeaderRow
 *  anatomy. Every slot reads the API; every absence states its reason. */
function SiteRow({ site, alertHours }: any) {
  const unplaced = site.site_id === null;
  const crit = site.alerts?.by_severity?.critical ?? 0;
  const area = site.gross_floor_area_sqm;
  // CCEI from the metric registry rides in score/score_reason/score_detail. A
  // refusal renders as the dash PLUS a compact per-component line — the full
  // registry reason stays on hover. Nothing rounds a refusal into a number.
  const detail = site.score_detail;
  const scoreSub =
    detail?.components?.length
      ? `CCEI v${detail.version} · ` +
        detail.components
          .map((c: any) =>
            c.status === "ok"
              ? `${c.metric}: ${Math.round(c.value)}`
              : `${c.metric}: ${String(c.status).replace(/_/g, " ")}`,
          )
          .join(" · ")
      : site.score_reason;
  const meta = unplaced
    ? "no site owns these points — pin devices on the floor plan under Sites"
    : `${area != null ? `${Number(area).toLocaleString()} m²` : "area —"} · ${site.city ?? "city —"}`;
  const metaTitle = unplaced
    ? undefined
    : `${area != null ? "" : "area not recorded — set it under Configurations → Sites. "}${
        site.city ? "" : "city not carried by the site mirror yet."
      }`.trim() || undefined;
  const kwhTitle =
    site.kwh?.status === "measured"
      ? site.kwh.reason
      : site.kwh?.reason ?? "no kWh register confirmed — confirm units in Ratings";
  return (
    <LeaderRow
      icon={unplaced ? "heroicons:map-pin" : "heroicons:building-office-2"}
      muted={unplaced}
      score={site.score == null ? null : Math.round(site.score)}
      scoreSub={scoreSub}
      title={unplaced ? "Unplaced" : site.site_name || "Unnamed site"}
      meta={meta}
      metaTitle={metaTitle}
      chips={
        <>
          {(site.categories || []).map((c: any) => (
            <LeaderChip
              key={c.category ?? "_none"}
              label={c.category ?? "unclassified"}
              value={c.points}
              title={`${c.devices} devices · ${c.points} points`}
            />
          ))}
          <LeaderChip
            label={`crit ${alertHours}h`}
            value={crit}
            tone={crit ? "crit" : "faint"}
            title={`alerts the gateway raised in the last ${alertHours} h, attributed through the device's placement`}
          />
          <LeaderChip
            label="kWh"
            value={site.kwh?.status === "measured" ? site.kwh.consumption_kwh : null}
            tone={site.kwh?.status === "measured" ? "good" : "faint"}
            title={kwhTitle}
          />
          <LeaderChip
            label={unplaced ? "unplaced" : "placed"}
            value={site.points}
            tone={unplaced ? "warn" : "good"}
            title={
              unplaced
                ? `${site.points} points no site owns — a real state, shown as one`
                : `${site.points} points placed at this site (${site.points_reporting} reporting)`
            }
          />
        </>
      }
      trend={null}
      trendTitle="no score history exists yet — CCEI began evaluating today, and a trend needs a history of scores"
      href={unplaced ? undefined : `/bi/energy?site=${site.site_id}`}
    />
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

  const sites = s?.sites || [];
  // Sites CCEI could honestly score; the mean is over THOSE, never padded.
  const scoredSites = sites.filter((x: any) => typeof x.score === "number");
  const scoredMean = scoredSites.length
    ? scoredSites.reduce((a: number, x: any) => a + x.score, 0) / scoredSites.length
    : null;
  const alertHours = s?.site_alert_hours ?? ALERT_HOURS;
  // Critical alerts across the estate — summed from the per-site breakdown so
  // the KPI and the leaderboard chips cannot disagree.
  const critTotal = sites.reduce(
    (n: number, x: any) => n + (x.alerts?.by_severity?.critical ?? 0),
    0,
  );
  // Measured consumption lights up ONLY from sites whose registers an operator
  // confirmed. Today that is none of them, and the slot says why.
  const measured = sites.filter((x: any) => x.kwh?.status === "measured");
  const measuredTotal = measured.length
    ? measured.reduce((n: number, x: any) => n + (x.kwh.consumption_kwh || 0), 0)
    : null;

  return (
    <ConsolePage>
      {/* No page title and no standfirst. The nav already says Portfolio, and the
          paragraph that used to sit here restated what the KPI strip shows one
          line lower.

          This strip carries the two ages nothing else on the page states, and they
          answer DIFFERENT questions: `last reading` is how fresh the ESTATE is (the
          newest reading in the store), `updated` is how fresh this PAGE is. A stale
          estate behind a freshly-fetched page is exactly the failure worth seeing,
          so both stay, side by side. */}
      <div className="mb-3 flex shrink-0 items-center justify-end gap-2 text-[11px] text-nb-faint">
        {summaryQ.isFetching && (
          <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" />
        )}
        {s && (
          <>
            <span>
              last reading <span className="text-nb-soft">{fmtRelative(s.last_reading_at)}</span>
            </span>
            <span className="text-nb-line">·</span>
            <span>updated {fmtRelative(s.generated_at)}</span>
          </>
        )}
      </div>

      {err ? (
        <SectionCard className="text-center text-xs text-nb-crit">{err}</SectionCard>
      ) : summaryQ.isLoading ? (
        <LoadingBlock label="Reading the store…" />
      ) : (
        // THE PAGE ITSELF DOES NOT SCROLL. The KPI strip is pinned and the two
        // columns scroll independently inside what is left of the viewport, so the
        // numbers a glance is for never leave the screen.
        //
        // Only from `xl` up. Below that the columns stack into one narrow lane that
        // cannot fit a leaderboard AND a chart at any height, and pinning there
        // would trap content in a few unusable pixels — narrow gets an ordinary
        // page scroll, which is the honest behaviour for it.
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-1">
          <KpiStrip className="shrink-0">
            <Kpi
              icon="heroicons:star"
              label="Portfolio score"
              value={scoredSites.length ? Math.round(scoredMean!) : null}
              sub={
                scoredSites.length
                  ? `mean CCEI over ${scoredSites.length} scored site(s)`
                  : "CCEI blocked on every site — the rows name which components are missing"
              }
              title="CCEI v2 = 0.35 × EEI + 0.25 × OPI + 0.20 × CPI + 0.20 × CCI — the NEUBIT CCEI Methodology Specification v1.0, evaluated by the metric registry per site over four sub-indices and fourteen component metrics. A composite of a refusal is a refusal: the dash names every component the estate cannot yet measure, at its spec weight, and what is in the way — never an invented number."
            />
            <Kpi
              icon="heroicons:cpu-chip"
              label="Devices"
              value={s.total_devices}
              sub="reporting into the store"
            />
            <Kpi
              icon="heroicons:signal"
              label="Points"
              value={s.total_points}
              sub={`${s.total_points_reporting} reporting in last ${s.fresh_minutes} min`}
              tone={s.total_points_reporting === s.total_points ? "good" : "warn"}
            />
            <Kpi
              icon="heroicons:bolt"
              label="Measured kWh"
              value={measuredTotal != null ? measuredTotal.toLocaleString() : null}
              sub={
                measuredTotal != null
                  ? `${measured.length} site(s), operator-confirmed registers, ${alertHours}h`
                  : "no kWh register confirmed — confirm units in Ratings"
              }
              tone="good"
              title={
                measuredTotal != null
                  ? undefined
                  : "Consumption is last − first over a confirmed kWh register. Zero registers are confirmed, so there is nothing measured to show — confirming them happens in Ratings, by a human."
              }
            />
            <Kpi
              icon="heroicons:bell-alert"
              label={`Critical · ${alertHours}h`}
              value={critTotal}
              sub="raised by the gateway, nothing inferred"
              tone={critTotal ? "crit" : "good"}
            />
          </KpiStrip>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-[1.52fr_1fr] xl:overflow-hidden">
            {/* The leaderboard owns the column's whole height and scrolls its
                ROWS, not itself: the heading stays put while the sites move
                under it. This is the list that grows — a second site, a tenth,
                a portfolio — so it is the one given the height that is left
                over rather than a height of its own. */}
            <div className="flex min-w-0 flex-col xl:min-h-0">
              <SectionCard className="flex min-h-0 flex-1 flex-col">
                <SectionHead
                  icon="heroicons:trophy"
                  title="Site leaderboard"
                  desc="Sites the store has been told about, plus the points no site owns. A dash is a blocked score — its reasons sit on the row."
                />
                <Leaderboard className="min-h-0 flex-1 overflow-y-auto pr-1">
                  {sites.map((site: any) => (
                    <SiteRow key={site.site_id ?? "_unplaced"} site={site} alertHours={alertHours} />
                  ))}
                </Leaderboard>
              </SectionCard>
            </div>

            {/* Two cards, each answering for its own height — NOT one column
                scrolled as a unit. Scrolling the column moved the ingest chart
                off screen to reach the fault list, which is the one pairing on
                this page that has to be read together: a queue that suddenly
                fills means nothing until you can see whether ingest fell over at
                the same hour.

                The chart is a fixed 150px of bars, so it is fixed. The queue is
                the list that varies, so it takes the height left over and
                scrolls its rows inside itself. */}
            <div className="flex min-w-0 flex-col gap-3 xl:min-h-0 xl:overflow-y-auto">
              <SectionCard className="shrink-0">
                <SectionHead
                  icon="heroicons:chart-bar"
                  title="Ingest — last 24 hours"
                  hint="Samples per hour by category. A count of samples, not of any physical quantity — the source payloads carry no unit."
                />
                {activityQ.isLoading ? (
                  <LoadingBlock label="Loading rollup…" />
                ) : (
                  <ActivityChart rows={activityQ.data || []} />
                )}
              </SectionCard>

              <SectionCard className="shrink-0">
                <SectionHead
                  icon="heroicons:bell-alert"
                  title={`Live queue · ${ALERT_HOURS} h`}
                  hint="Raised by the gateway. Severity, type and wording are its own; nothing here is inferred."
                  // The counts belong on the title line: "how many, how bad" IS
                  // this panel's headline, and putting it here gives the faults
                  // themselves the row the chips used to take.
                  action={<FaultSeverity query={alertsQ} />}
                />
                <FaultQueue query={alertsQ} hours={ALERT_HOURS} />
              </SectionCard>
            </div>
          </div>

          {/* THE CATEGORY STRIP IS ONE ROW, PINNED, AND IT IS NOT IN A COLUMN.
              It used to sit under the leaderboard, which meant the two grew into
              the same scroll: every site added pushed the estate's category
              breakdown further out of reach, and the leaderboard never got the
              height it is the whole point of. Sites are the thing that grows
              here; categories are the thing that does not. So the set that grows
              gets the flexible height, and the set that is fixed gets a fixed
              row.

              It scrolls sideways rather than wrapping, because a wrap would make
              this strip two rows tall on some viewports and one on others — and
              the leaderboard above would change height with it for no reason a
              reader could see. */}
          <div className="flex shrink-0 gap-3 overflow-x-auto pb-0.5">
            {s.categories.map((row: any) => (
              <CategoryCard key={row.category ?? "_none"} row={row} />
            ))}
          </div>
        </div>
      )}
    </ConsolePage>
  );
}
