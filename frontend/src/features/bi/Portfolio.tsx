"use client";

// Building Intelligence → L1 BUILDING. The home of the console, and the top of
// ONE pipeline rather than the first of ten sibling tiles.
//
// WHAT CHANGED AND WHY. This screen was PORTFOLIO: a KPI strip over a site
// leaderboard. It answered "which site scores best" on a deployment with one
// site, while the questions the building actually has to answer — what is it
// consuming, how efficiently, what is failing, what has gone quiet — were
// scattered across nine other tiles a user had to know to visit. Worse, two of
// those tiles were WORKLISTS for shut gates, sitting as peers of the estate view,
// so the pipeline the console is modelled on was invisible in the product.
//
// The layer stack is now what the console is:
//
//   L1 BUILDING   the six gates · the questions · the domains        (this file)
//   L2 DOMAIN     the same gate strip, scoped, over the equipment    (CategoryConsole)
//   L3 PLANT      schematic, fault, ticket                           (not built)
//
// So this page reads top to bottom as: can these numbers be trusted (the gate
// strip), what do they say (the questions), and where do they come from (the
// domains). The estate detail that used to BE the page — the leaderboard, the
// ingest chart, the fault queue — is still here, below, where a reader goes
// after the answer rather than instead of it.
//
// THE ROUTE IS STILL /bi/portfolio. The URL is what Portfolio's own links, the
// console strip and anyone's bookmark already name, and renaming it would break
// them to gain a word. The SCREEN is Building; the path is history.
//
// THE GATE FACTS LEFT THIS FILE. The point count used to carry its own
// duplicate-generation annotation here, in this file's markup, while the units
// panel counted its own backlog and the succession console counted its own
// orphans — three screens each stating a gate's facts in their own wording. All
// of it is now `features/bi/gates.ts` and rendered by `<GateStrip>`, which says
// WHICH gate is shut and what is upstream of it. The properties that annotation
// had to hold did not change and are still tested; they are tested on the strip.
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
// THE CORRELATIONS LANE IS NOW REAL, and it sits between the questions and the
// domains. The slot was a comment in this file for as long as the backend was
// being built, because a card reading "correlations, coming soon" is a control
// with no consumer. `GET /bi/correlations` shipped, so the lane reads it — and
// it reads ABOVE the Domains lane on purpose: a domain count is table stakes and
// a cross-domain answer is not, so the thing a competitor cannot produce is not
// filed underneath the thing every competitor has.
//
// THE PAGE DOES NOT EXPLAIN ITSELF ON SCREEN, and that is a deliberate trade. It
// used to carry a standfirst, a "What is not here" panel and a paragraph under
// Floor-wise — together more prose than data, which buried the numbers they were
// meant to qualify. Those reasons did not stop being true, so they live HERE,
// where the next person to change this file reads them, instead of in front of an
// operator who reads the same four paragraphs every morning.
//
// The rule that survives ON screen is the one that cannot be moved: a slot with
// no honest input renders "—" and carries its reason in the row or the tooltip
// beside it, never a zero and never a guess.
//
// THE SAME TRADE WAS THEN MADE ON WHAT WAS LEFT. The standfirst and the three
// section descriptions were still paragraphs in front of an operator who reads
// them every morning. None of them was wrong and none of them was deleted: each
// one moved onto the `hint` / `title` of the thing it qualifies, which is one
// hover away and costs the screen no line. The `sub` under a blocked KPI stayed
// where it is — a blocked number printing its blockage is the rule, not the
// prose.
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
  KpiStrip,
  Kpi,
  EstateHeader,
  Leaderboard,
  LeaderRow,
  LeaderChip,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import ActivityChart from "./components/ActivityChart";
import Correlations from "./components/Correlations";
import FaultQueue, { FaultSeverity } from "./components/FaultQueue";
import GateStrip from "./components/GateStrip";
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
              : `${c.metric}: ${String(c.status).replaceAll("_", " ")}`,
          )
          .join(" · ")
      : site.score_reason;
  // Each missing fact says so in the line AND explains itself on hover. A blank
  // where a figure belongs reads as zero; "area —" reads as nobody has said.
  const areaText = area != null ? `${Number(area).toLocaleString()} m²` : "area —";
  const gaps = [
    area != null ? null : "area not recorded — set it under Configurations → Sites.",
    site.city ? null : "city not carried by the site mirror yet.",
  ].filter(Boolean);
  const meta = unplaced
    ? "no site owns these points — assign their devices to a building"
    : `${areaText} · ${site.city ?? "city —"}`;
  const metaTitle = unplaced ? undefined : gaps.join(" ") || undefined;
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
      // The unplaced row's count ships with the action that changes it: gate 3's
      // worklist, where its devices are assigned to a building by name.
      href={unplaced ? "/bi/placement" : `/bi/energy?site=${site.site_id}`}
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
  // answer about the same stretch of time rather than quietly disagreeing — and
  // the same key and window gate 6 reads, so the strip and the queue share one
  // request rather than making two that can disagree.
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
  const quietPoints = s ? s.total_points - s.total_points_reporting : null;

  return (
    <ConsolePage>
      {/* The page says what layer it is, because there are three and the other
          two are reached from it. The two ages in the right-hand slot answer
          DIFFERENT questions: `last reading` is how fresh the ESTATE is (the
          newest reading in the store), `updated` is how fresh this PAGE is. A
          stale estate behind a freshly-fetched page is exactly the failure worth
          seeing, so both stay, side by side. */}
      <EstateHeader
        crumbs={[{ label: "Building" }]}
        desc={
          <span title="One building, one pipeline. The gates say whether these numbers can be trusted; the questions are what the building has to answer; the domains are where the numbers come from.">
            gates · questions · domains
          </span>
        }
        right={
          <>
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
          </>
        }
      />

      {err ? (
        <SectionCard className="text-center text-xs text-nb-crit">{err}</SectionCard>
      ) : summaryQ.isLoading ? (
        <LoadingBlock label="Reading the store…" />
      ) : (
        // ORDINARY PAGE SCROLL. The old layout pinned a KPI strip and scrolled two
        // columns inside the viewport, which works for a page that IS a
        // leaderboard. This one is a stack — gates, questions, domains, detail —
        // and pinning part of a stack traps the rest in a few pixels.
        <ConsoleScroll className="space-y-3">
          {/* ── THE GATES ─ can these numbers be trusted ──────────────────────
              One component, every layer, rescoped to its subject. Healthy, it is
              a single faint line; shut, the blocked gate expands with its own
              worklist in context. See components/GateStrip.tsx. */}
          <GateStrip subject={{ kind: "estate", label: "the estate" }} />

          {/* ── THE QUESTIONS ─ what this building has to answer ──────────────
              Not a KPI strip of whatever the store happens to expose: five
              questions, each with the number that answers it or the sentence
              that says what is blocking it and where it is unblocked. A blocked
              slot prints "—" plus its reason — never a zero, never a guess. */}
          <section>
            <SectionHead
              icon="heroicons:question-mark-circle"
              title="What this building has to answer"
              hint="Five questions. Each one carries either a measured number or what is in the way of it."
            />
            <KpiStrip className="mt-2">
              <Kpi
                icon="heroicons:bolt"
                label="What is it consuming?"
                value={measuredTotal != null ? measuredTotal.toLocaleString() : null}
                sub={
                  measuredTotal != null
                    ? `kWh · ${measured.length} site(s), operator-confirmed registers, ${alertHours}h`
                    : "no kWh register confirmed — confirm units in Ratings"
                }
                tone="good"
                title={
                  measuredTotal != null
                    ? undefined
                    : "Consumption is last − first over a confirmed kWh register. Zero registers are confirmed, so there is nothing measured to show — confirming them happens in Ratings, by a human."
                }
                action={
                  measuredTotal != null ? null : (
                    <Link href="/bi/ratings" className="text-nb-blueb hover:underline">
                      Confirm a kWh register →
                    </Link>
                  )
                }
              />
              <Kpi
                icon="heroicons:star"
                label="How efficiently?"
                value={scoredSites.length ? Math.round(scoredMean!) : null}
                sub={
                  scoredSites.length
                    ? `CCEI 0-100 · mean over ${scoredSites.length} scored site(s)`
                    : "CCEI blocked — the rows name what is missing"
                }
                title="CCEI v2 = 0.35 × EEI + 0.25 × OPI + 0.20 × CPI + 0.20 × CCI — the NEUBIT CCEI Methodology Specification v1.0, evaluated by the metric registry per site over four sub-indices and fourteen component metrics. A composite of a refusal is a refusal: the dash names every component the estate cannot yet measure, at its spec weight, and what is in the way — never an invented number."
              />
              <Kpi
                icon="heroicons:bell-alert"
                label="What is failing now?"
                value={critTotal}
                sub={`critical · ${alertHours} h`}
                title={`Alerts the gateway raised in the last ${alertHours} hours. The severity and the wording are its own; nothing here is inferred.`}
                tone={critTotal ? "crit" : "good"}
              />
              <Kpi
                icon="heroicons:signal-slash"
                label="What has gone quiet?"
                value={quietPoints}
                sub={`points silent longer than ${s.fresh_minutes} min, of ${s.total_points}`}
                tone={quietPoints ? "warn" : "good"}
              />
              <Kpi
                icon="heroicons:cpu-chip"
                label="What is it made of?"
                value={s.total_devices}
                sub={`devices · ${s.total_points} points across ${s.categories.length} domains`}
                title="Devices and points the store holds, counted from the rows a reading created. Gate 1 above says how many of those rows are later generations of a register already counted."
              />
            </KpiStrip>
          </section>

          {/* ── THE CORRELATIONS LANE ─ what one domain cannot answer ────────
              ABOVE the domains, deliberately. A per-domain count is table
              stakes — every BMS ships one, because every BMS owns a domain. A
              cross-domain answer is the thing a competitor structurally cannot
              produce, so it reads first and the domain cards below it are the
              inventory it is drawn from. See components/Correlations.tsx, which
              owns the tri-state rule the headline rests on. */}
          <Correlations />

          {/* ── THE DOMAINS ─ where the numbers come from ─────────────────────
              These are DOMAINS OF ONE ESTATE, not three products, which is why
              they are a lane here rather than three tiles on the launcher. Each
              card opens L2 — the same gate strip, scoped, over that domain's
              equipment.

              The lane scrolls sideways rather than wrapping: a wrap would make
              it two rows tall on some viewports and one on others, and
              everything below it would move for no reason a reader could see. */}
          <section>
            <SectionHead
              icon="heroicons:squares-2x2"
              title="Domains"
              hint="Every category the gateway has classified and reported. A domain is a scope of this estate — open one for the same gates over its own equipment."
            />
            <div className="mt-2 flex gap-3 overflow-x-auto pb-0.5">
              {s.categories.map((row: any) => (
                <CategoryCard key={row.category ?? "_none"} row={row} />
              ))}
            </div>
          </section>

          {/* ── THE ESTATE DETAIL ─ after the answer, not instead of it ───────
              The leaderboard, the ingest chart and the fault queue. The chart and
              the queue stay side by side because that pairing has to be read
              together: a queue that suddenly fills means nothing until you can
              see whether ingest fell over at the same hour. */}
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.52fr_1fr]">
            <SectionCard>
              <SectionHead
                icon="heroicons:trophy"
                title="Site leaderboard"
                hint="Sites the store has been told about, plus the points no site owns. A dash is a blocked score — its reasons sit on the row."
              />
              <Leaderboard>
                {sites.map((site: any) => (
                  <SiteRow key={site.site_id ?? "_unplaced"} site={site} alertHours={alertHours} />
                ))}
              </Leaderboard>
            </SectionCard>

            <div className="flex min-w-0 flex-col gap-3">
              <SectionCard>
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

              <SectionCard>
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
        </ConsoleScroll>
      )}
    </ConsolePage>
  );
}
