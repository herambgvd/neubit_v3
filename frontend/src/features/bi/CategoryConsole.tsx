"use client";

// One domain of the estate — the shared console behind the Energy & Metering,
// HVAC & Assets and Water tiles (category=energy / hvac / water).
//
// They are the same screen with a different filter because the store makes them
// the same shape: a device with a classification, some points, and a value per
// point. Two copies would drift; one component with a `category` prop cannot.
//
// ── TWO SCOPES, ONE ROUTE, AND THEY MUST NEVER BE CONFUSED ──────────────────
//
//   /bi/energy              THE WHOLE ESTATE — every building's energy combined,
//                           PLUS the points no building owns.
//   /bi/energy?site=<uuid>  ONE BUILDING — only the devices pinned on that
//                           building's floor plan.
//
// Domain-first across the portfolio is what a facilities director asks;
// building-first is what a site engineer asks. Both are real, and the unscoped
// one is not a lazier version of the scoped one: 366 energy points, 95 HVAC
// points and 10 water points belong to NO site at all, so the estate scope is
// the ONLY place they can be seen. A restructure once removed the unscoped door
// on the argument that Building's Domains lane already reached "the same room";
// it does not, and those points went unreachable.
//
// Because one route serves both, the screen has to SAY which it is, in more than
// a breadcrumb: a scope banner that names it, a rollup that only the estate
// scope carries, and a gate strip whose subject follows the scope. An operator
// who is unsure which of the two they are reading is worse off than one who only
// ever had one of them.
//
// The three reads and WHY each hits the store it hits:
//   • device list      → `points` dimension, grouped. One row per series, cheap,
//                        and it never touches the hypertable.
//   • latest values    → RAW readings over a bounded lookback. `readings_1m` is
//                        materialized-only with a ~2 minute freshness floor, and
//                        a current-value column that is two minutes behind the
//                        building is a different (worse) product. Bounded, so the
//                        cost does not grow with history.
//   • the trend chart  → a ROLLUP, always. The API picks readings_1m up to three
//                        hours and readings_1h beyond, and returns which it used;
//                        the caption prints that instead of implying a precision
//                        the chart does not have.
//
// No unit is rendered anywhere. `points.unit` is NULL for every point because the
// gateway's payloads carry none (contract §11/§12), and a fabricated one on an
// energy screen is worse than a blank.
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelSearch,
  PanelList,
  PanelFooter,
  EmptyPane,
  InfoCell,
  Segmented,
  LoadingBlock,
  EstateHeader,
  SectionCard,
  SectionHead,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import DeltaT, { hasDeltaT } from "./components/DeltaT";
import GateStrip from "./components/GateStrip";
import TrendChart from "./components/TrendChart";
import Reason from "./components/Reason";
import { bi } from "./api";
import { categoryMeta, deviceTypeLabel, fmtReading, qualityTone } from "./constants";

const RANGES = [
  { value: 1, label: "1H" },
  { value: 6, label: "6H" },
  { value: 24, label: "24H" },
  { value: 168, label: "7D" },
];

/** WHICH SCOPE, said once, in the same place, in both states. The two states
 *  are deliberately the same shape and different words: a reader recognises the
 *  badge and then reads which one it is, rather than having to notice that a
 *  breadcrumb has one more crumb than it did. */
function ScopeBadge({ site }: Readonly<{ site: boolean }>) {
  return (
    <span
      className={`flex items-center gap-1.5 rounded-[7px] border px-2 py-1 text-[10.5px] font-semibold uppercase tracking-[1.2px] ${
        site
          ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)] text-nb-blueb"
          : "border-[rgba(167,139,250,.45)] bg-[rgba(167,139,250,.12)] text-[#c4b5fd]"
      }`}
      title={
        site
          ? "One building. Only devices pinned on this building's floor plan — the rest of the estate is excluded."
          : "The whole estate: every building combined, plus the points no building owns."
      }
    >
      <Icon icon={site ? "heroicons-outline:map-pin" : "heroicons-outline:globe-alt"} className="text-[13px]" />
      {site ? "One building" : "Whole estate"}
    </span>
  );
}

/** THE ESTATE ROLLUP — the thing that makes the unscoped console a rollup rather
 *  than an unfiltered list.
 *
 *  WHAT IT IS AND WHY THIS AND NOT SOMETHING ELSE. The obvious rollup — this
 *  domain's TOTAL CONSUMPTION across the estate — cannot be built and must not
 *  be faked: `points.unit` is null for every point on this deployment (contract
 *  §11/§12), so summing values across meters would be adding numbers that do not
 *  share a quantity. What the API DOES already supply, in the same
 *  `/bi/summary` the gate strip reads under the same query key, is
 *  `sites[].categories[]` — this domain's devices and points per building, plus
 *  the UNPLACED PSEUDO-ROW (`site_id: null`) for the points no building owns. So
 *  the rollup is a rollup of WHERE THIS DOMAIN LIVES, which is a question the
 *  store can answer exactly, and every row is a door: a building opens the
 *  scoped console, the unplaced remainder opens gate 3's assign worklist.
 *
 *  THE CAVEAT IS NOT DECORATION. There is exactly ONE real site on this
 *  deployment, so "every building combined" is one building and a large
 *  remainder. The head states the building count it actually found and states
 *  the remainder as its own row rather than folding it into a total — that
 *  remainder is the biggest fact on this screen, and a rollup that implied a
 *  portfolio which is not there would be the fabrication this console exists not
 *  to ship.
 *
 *  A summary that has not answered prints NO figure. Not a zero, not a dash with
 *  nothing behind it — the sentence that says what is missing. */
function EstateRollup({
  category,
  meta,
  summary,
  loading,
}: Readonly<{ category: string; meta: any; summary: any; loading: boolean }>) {
  const rows = useMemo(() => {
    const out: any[] = [];
    for (const site of summary?.sites ?? []) {
      const c = (site.categories || []).find((x: any) => x.category === category);
      // A building with none of this domain is not a row. It is a fact about
      // another domain, and printing it here as three zeros would pad the
      // rollup with buildings this screen has nothing to say about.
      if (!c || !c.points) continue;
      out.push({
        key: site.site_id ?? "_unplaced",
        unplaced: site.site_id === null,
        name: site.site_id === null ? "No building" : site.site_name || "Unnamed building",
        devices: c.devices,
        points: c.points,
        // The remainder opens gate 3's worklist, scoped to this domain.
        href:
          site.site_id === null
            ? `/bi/placement?category=${encodeURIComponent(category)}`
            : `/bi/${category}?site=${site.site_id}`,
        action: site.site_id === null ? "Assign them to a building" : "Open this building",
      });
    }
    // The unplaced remainder last: it is the residue of the estate, not a peer
    // of the buildings, and reading it first would suggest it is a place.
    return out.sort((a, b) => Number(a.unplaced) - Number(b.unplaced) || b.points - a.points);
  }, [summary, category]);

  const buildings = rows.filter((r) => !r.unplaced);
  const unplaced = rows.find((r) => r.unplaced) ?? null;

  return (
    <SectionCard className="mb-3 shrink-0">
      <SectionHead
        icon="heroicons:squares-2x2"
        title={`${meta.label} across the estate`}
        // `desc` is the FACT, `hint` is the argument behind it. Both still ship;
        // only one of them costs a line of the screen every time it is read.
        hint={
          summary
            ? "This is where the domain lives — not what it consumed: the source payloads carry no unit, so nothing here is summed into a quantity."
            : "No figure is shown rather than a zero that would read as an answer."
        }
        desc={
          loading
            ? "Asking the store where this domain lives…"
            : !summary
              ? "The estate summary has not answered, so this rollup cannot say where the domain lives."
              : `${buildings.length} ${buildings.length === 1 ? "building has" : "buildings have"} ${meta.label} pinned to ${buildings.length === 1 ? "it" : "them"}${
                  unplaced
                    ? `, and ${unplaced.points} ${unplaced.points === 1 ? "point belongs" : "points belong"} to no building at all.`
                    : ", and every point of this domain belongs to one of them."
                }`
        }
      />
      {summary && (
        <div className="flex flex-col gap-1.5">
          {rows.length === 0 && (
            <p className="text-[11.5px] text-nb-faint">
              The store holds no {meta.label} points at all — neither at a building nor outside one.
            </p>
          )}
          {rows.map((r) => (
            <Link
              key={r.key}
              href={r.href}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-[10px] border px-3 py-2 transition hover:bg-white/[.03] ${
                r.unplaced
                  ? "border-[rgba(251,191,36,.35)] bg-[rgba(251,191,36,.06)] hover:border-[rgba(251,191,36,.7)]"
                  : "border-nb-line bg-[rgba(6,11,26,.45)] hover:border-nb-blue/60"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon
                  icon={r.unplaced ? "heroicons:exclamation-triangle" : "heroicons:building-office-2"}
                  className={`text-[14px] ${r.unplaced ? "text-nb-warn" : "text-nb-faint"}`}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] text-nb-ink">{r.name}</span>
                  <span className="block text-[10.5px] text-nb-faint">{r.action}</span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-[11px] text-nb-faint">
                <span>
                  <span className="font-mono text-[13px] text-nb-ink">{r.devices}</span> devices
                </span>
                <span>
                  <span className="font-mono text-[13px] text-nb-ink">{r.points}</span> points
                </span>
                <Icon icon="heroicons:arrow-up-right" className="text-[12px]" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// Wrapper so `useSearchParams` (the ?site= scope) sits under a Suspense
// boundary, which the app router requires of any prerendered client page.
export default function CategoryConsole(props: Readonly<{ category: string }>) {
  return (
    <Suspense fallback={null}>
      <CategoryConsoleInner {...props} />
    </Suspense>
  );
}

function CategoryConsoleInner({ category }: Readonly<{ category: string }>) {
  const meta = categoryMeta(category);
  // Portfolio drill-down: `?site=<uuid>` scopes the console to the devices
  // placed at that site. WITHOUT the param nothing below changes — the unscoped
  // routes are untouched, this is the same console with one more filter.
  const siteId = useSearchParams().get("site");
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pointId, setPointId] = useState<string | null>(null);
  const [hours, setHours] = useState(6);

  const devicesQ = useQuery<any>({
    queryKey: ["bi-devices", category, siteId],
    queryFn: () => bi.devices({ category, site_id: siteId || undefined, limit: 500 }),
    refetchInterval: 60_000,
  });

  // Resolve the site's NAME for the breadcrumb from the site_facts mirror —
  // the same read Ratings uses. Only fetched when scoped.
  const sitesQ = useQuery<any>({
    queryKey: ["bi-rating-sites"],
    queryFn: () => bi.ratingSites(),
    enabled: !!siteId,
    staleTime: 60_000,
  });
  const siteName = siteId
    ? sitesQ.data?.items?.find((x: any) => x.site_id === siteId)?.site_name || siteId
    : null;

  const devices = useMemo(() => devicesQ.data?.items ?? [], [devicesQ.data]);

  // Equipment kinds present in THIS category, derived from what came back rather
  // than from a hard-coded list — the vocabulary is the gateway's, not ours.
  const types = useMemo(() => {
    const set = new Map<string, number>();
    for (const d of devices) {
      const k = d.device_type || "";
      set.set(k, (set.get(k) || 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [devices]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return devices.filter(
      (d: any) =>
        (!typeFilter || (d.device_type || "") === typeFilter) &&
        (!term || (d.device_tag || "").toLowerCase().includes(term)),
    );
  }, [devices, search, typeFilter]);

  // Select the first device once, so the detail pane is never empty on arrival.

  // The explicit choice, or the first row once the list lands. Derived rather
  // than synced in an effect, which rendered one empty frame first.
  const effectiveDeviceId = deviceId ?? filtered[0]?.device_id ?? null;

  const selected = devices.find((d: any) => d.device_id === effectiveDeviceId) || null;

  const pointsQ = useQuery<any>({
    queryKey: ["bi-points", effectiveDeviceId],
    queryFn: () => bi.points({ device_id: effectiveDeviceId, with_latest: true, limit: 500 }),
    enabled: !!effectiveDeviceId,
    // Values are LIVE — the API reads raw for these, so polling them is the point.
    refetchInterval: 20_000,
  });

  const points = useMemo(() => pointsQ.data?.items ?? [], [pointsQ.data]);

  // Chart the first NUMERIC point of the device until the operator picks another.
  useEffect(() => {
    if (!points.length) return;
    if (pointId && points.some((p: any) => p.point_id === pointId)) return;
    const firstNum = points.find((p: any) => p.latest && p.latest.num !== null) || points[0];
    setPointId(firstNum?.point_id ?? null);
  }, [points, pointId]);

  const seriesQ = useQuery<any>({
    queryKey: ["bi-series", pointId, hours],
    queryFn: () => bi.series({ point_id: [pointId], hours }),
    enabled: !!pointId,
    refetchInterval: 60_000,
  });

  const series = seriesQ.data?.series?.[0] || null;
  const chartedPoint = points.find((p: any) => p.point_id === pointId) || null;

  const devErr = devicesQ.error ? apiError(devicesQ.error, "Could not load devices") : null;

  // The estate rollup and the gate strip both read `/bi/summary`, under the SAME
  // query key the strip already uses — so the rollup costs no extra request and
  // the two can never disagree about where this domain's points are.
  const summaryQ = useQuery<any>({
    queryKey: ["bi-summary"],
    queryFn: () => bi.summary(),
    refetchInterval: 60_000,
  });

  return (
    <ConsolePage>
      {/* One header anatomy across every BI page, and the FIRST place the two
          scopes separate. Scoped, the crumb is the drill (Building / <domain> /
          <site>) and the middle crumb is the way back OUT of the building scope;
          unscoped, the crumb stops at the domain. The badge on the right says
          which one it is in two words, because a reader should not have to count
          breadcrumbs to know what they are looking at. */}
      {siteId ? (
        <EstateHeader
          crumbs={[
            { label: "Building", href: "/bi/portfolio" },
            { label: meta.label, href: `/bi/${category}` },
            { label: siteName ?? "…" },
          ]}
          desc={
            <span
              title={`A device is here because it is pinned on this building's floor plan; every other building, and every point no building owns, is excluded. The estate-wide view is the ${meta.label} crumb above.`}
            >
              {`ONE BUILDING — ${meta.label} at this site only.`}
            </span>
          }
          right={<ScopeBadge site />}
        />
      ) : (
        <EstateHeader
          crumbs={[{ label: "Building", href: "/bi/portfolio" }, { label: meta.label }]}
          desc={
            <span title="Open a building below to scope this same console to it. Values carry no unit — the wire sends none, and none is invented.">
              {`THE WHOLE ESTATE — every ${meta.label} device that has reported, in every building AND outside all of them.`}
            </span>
          }
          right={<ScopeBadge site={false} />}
        />
      )}

      {/* ── THE ESTATE ROLLUP ─ only ever at estate scope ────────────────────
          The unscoped console must read as a rollup and not as an unfiltered
          list, and this is what makes the difference: where this domain lives,
          building by building, with the points no building owns stated as their
          own row. It is also the drill INTO the other scope. A site-scoped
          console never shows it — a per-building breakdown inside one building
          would be a list of one. */}
      {!siteId && (
        <EstateRollup
          category={category}
          meta={meta}
          summary={summaryQ.data}
          loading={summaryQ.isLoading}
        />
      )}

      {/* ── L2 ─ THE SAME SIX GATES, AT WHICHEVER SCOPE THIS IS ──────────────
          One strip, every layer, and its SUBJECT follows the scope — because a
          strip that showed the estate's counts under a building's name is the
          one mistake a two-scope console cannot survive.

          Unscoped, the subject is the DOMAIN: this domain's duplicates, units,
          unplaced remainder and stranded roles, across every building.

          Scoped, the subject is the BUILDING, and what changes is not just the
          arithmetic. Gate 3 · BELONGS passes here by construction — `?site=`
          selects on the pin, so every point in view belongs to a place — while
          the estate strip is shut on that same gate with the unplaced remainder
          in it. Gate 5 · RATES reads this building's own CCEI. Gates 1, 2 and 4
          DEFER and say so: their worklists are scoped by category and carry no
          site, so an answer here would be the domain's wearing a building's
          name. `gates.ts` owns every one of those sentences. */}
      <GateStrip
        className="mb-3 shrink-0"
        subject={
          siteId
            ? { kind: "site", category, siteId, label: `${meta.label} at ${siteName ?? "this building"}` }
            : { kind: "domain", category, label: meta.label }
        }
      />

      <ConsoleGrid cols="xl:grid-cols-[25%_1fr]">
        {/* ── devices ─────────────────────────────────────────────── */}
        <ConsolePanel>
          <PanelHeader icon={meta.icon} title={meta.label} count={devicesQ.data?.total ?? ""} />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search devices…" />
          {types.length > 1 && (
            <div className="nav-scroll flex gap-1 overflow-x-auto px-3 pb-2">
              <button
                type="button"
                onClick={() => setTypeFilter("")}
                className={`shrink-0 rounded-[6px] border px-2 py-0.5 text-[10.5px] transition ${
                  !typeFilter
                    ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.15)] text-nb-blueb"
                    : "border-nb-line text-nb-faint hover:text-nb-muted"
                }`}
              >
                All
              </button>
              {types.map(([t, n]) => (
                <button
                  key={t || "_none"}
                  type="button"
                  onClick={() => setTypeFilter(t)}
                  className={`shrink-0 rounded-[6px] border px-2 py-0.5 text-[10.5px] transition ${
                    typeFilter === t
                      ? "border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.15)] text-nb-blueb"
                      : "border-nb-line text-nb-faint hover:text-nb-muted"
                  }`}
                >
                  {deviceTypeLabel(t)} <span className="font-mono">{n}</span>
                </button>
              ))}
            </div>
          )}
          <PanelList
            loading={devicesQ.isLoading}
            error={devErr}
            empty={!filtered.length}
            emptyText={
              siteId
                ? "No device in this category is placed at this site"
                : "No device in this category has reported"
            }
          >
            {filtered.map((d: any) => {
              const on = d.device_id === effectiveDeviceId;
              const quiet = d.points - d.points_reporting;
              return (
                <button
                  key={d.device_id || d.device_tag}
                  type="button"
                  onClick={() => {
                    setDeviceId(d.device_id);
                    setPointId(null);
                  }}
                  className={`w-full rounded-[10px] border px-3 py-2 text-left transition ${
                    on
                      ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.12)]"
                      : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] text-nb-ink">{d.device_tag}</span>
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        quiet ? "bg-nb-warn" : "bg-nb-good shadow-[0_0_5px_#34d399]"
                      }`}
                      title={quiet ? `${quiet} of ${d.points} points quiet` : "all points reporting"}
                    />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-nb-faint">
                    <span>{deviceTypeLabel(d.device_type)}</span>
                    <span className="font-mono">{d.points} pts</span>
                  </div>
                </button>
              );
            })}
          </PanelList>
          <PanelFooter>
            <Reason text="A device is listed because it has REPORTED. The store has no configuration side — the reading-writer creates a row from a reading, never from a device list." />
          </PanelFooter>
        </ConsolePanel>

        {/* ── detail ──────────────────────────────────────────────── */}
        <ConsolePanel>
          {!selected ? (
            <EmptyPane
              icon={meta.icon}
              title="No device selected"
              subtitle="Pick a device to see its points and their latest values"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-nb-line px-5 py-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-nb-ink">
                    {selected.device_tag}
                  </h2>
                  <p className="mt-0.5 text-xs text-nb-faint">
                    {meta.label} · {deviceTypeLabel(selected.device_type)} · last reading{" "}
                    {fmtRelative(selected.last_seen_at)}
                  </p>
                </div>
                {pointsQ.isFetching && (
                  <Icon icon="svg-spinners:180-ring" className="text-base text-nb-blueb" />
                )}
              </header>

              <div className="grid grid-cols-2 gap-2 px-5 py-3 md:grid-cols-4">
                <InfoCell label="Points" value={selected.points} mono />
                <InfoCell
                  label="Reporting"
                  value={`${selected.points_reporting} / ${selected.points}`}
                  mono
                />
                <InfoCell label="Numeric / text" value={`${selected.numeric_points} / ${selected.text_points}`} mono />
                <InfoCell label="First seen" value={fmtRelative(selected.first_seen_at)} />
              </div>

              {/* ΔT — the first DERIVED value: a function of two of this
                  device's points, computed by the server at query time. Shown
                  only when the device publishes BOTH sides, because a card that
                  is permanently empty on every meter in the estate is noise
                  rather than honesty. */}
              {hasDeltaT(points) ? (
                <div className="px-5 pb-3">
                  <DeltaT
                    effectiveDeviceId={selected.device_id}
                    deviceTag={selected.device_tag}
                    hours={hours}
                    accent={meta.accent}
                  />
                </div>
              ) : null}

              {/* Trend — always a rollup. */}
              <div className="px-5 pb-3">
                <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                        Trend
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11.5px] text-nb-soft">
                        {chartedPoint?.point_tag ?? "—"}
                      </div>
                    </div>
                    <Segmented
                      value={hours}
                      onChange={setHours}
                      options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
                    />
                  </div>
                  {seriesQ.isLoading ? (
                    <LoadingBlock label="Loading rollup…" />
                  ) : (
                    <TrendChart buckets={series?.buckets || []} accent={meta.accent} label={chartedPoint?.point_tag} />
                  )}
                  {seriesQ.data && (
                    <p
                      className="mt-2 text-[10.5px] leading-relaxed text-nb-faint"
                      title="The shaded band is each bucket's min→max and the line is its average. No unit — the source reports none."
                    >
                      {seriesQ.data.resolution_reason}
                    </p>
                  )}
                </div>
              </div>

              {/* Points + latest values. */}
              <div className="px-5 pb-5">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                    Points
                  </div>
                  <span className="text-[10.5px] text-nb-faint">
                    current value read raw, last {pointsQ.data?.latest_lookback_minutes ?? 60} min
                  </span>
                </div>
                {pointsQ.isLoading ? (
                  <LoadingBlock label="Loading points…" />
                ) : (
                  <div className="overflow-hidden rounded-[10px] border border-nb-line">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                          <th className="px-3 py-2 font-semibold">Point</th>
                          <th className="px-3 py-2 font-semibold">Kind</th>
                          <th className="px-3 py-2 text-right font-semibold">Value</th>
                          <th className="px-3 py-2 text-right font-semibold">Measured</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* A device with NO points and a device whose points
                            failed to load must not both read as an empty table:
                            the first is a fact about the estate and has to say
                            so in words. */}
                        {points.length === 0 && (
                          <tr className="border-t border-nb-line/50">
                            <td colSpan={4} className="px-3 py-6 text-center text-[11.5px] text-nb-faint">
                              This device has reported no points
                            </td>
                          </tr>
                        )}
                        {points.map((p: any) => {
                          const on = p.point_id === pointId;
                          return (
                            <tr
                              key={p.point_id}
                              onClick={() => setPointId(p.point_id)}
                              className={`cursor-pointer border-t border-nb-line/50 transition ${
                                on ? "bg-[rgba(96,165,250,.1)]" : "hover:bg-white/[.03]"
                              }`}
                            >
                              <td className="px-3 py-1.5 font-mono text-[12px] text-nb-ink">
                                {p.point_tag}
                              </td>
                              <td className="px-3 py-1.5 text-[11px] text-nb-faint">{p.type}</td>
                              <td
                                className={`px-3 py-1.5 text-right font-mono text-[12.5px] ${
                                  p.latest ? qualityTone(p.latest.quality) || "text-nb-ink" : "text-nb-faint"
                                }`}
                                title={
                                  p.latest && p.latest.quality !== 0
                                    ? `device reported quality ${p.latest.quality}`
                                    : undefined
                                }
                              >
                                {fmtReading(p.latest)}
                              </td>
                              <td className="px-3 py-1.5 text-right text-[11px] text-nb-faint">
                                {p.latest ? fmtRelative(p.latest.ts) : "no sample in window"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
