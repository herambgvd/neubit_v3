"use client";

// Building Intelligence → RATINGS.
//
// WHAT THIS TILE WAS BLOCKED ON, AND WHAT CHANGED.
// An EPI is kWh / m² / year. Three inputs, and the platform could state none of
// them: `points.unit` was null everywhere with no way for anyone to fix it, no
// table anywhere held a built-up area, and no benchmark standard was recorded.
// The launcher called that "any score would be invented", which was right about
// the score and wrong about the conclusion: the answer is not to give up, it is
// to build the PATH by which an operator supplies what is missing.
//
// So this screen is two things at once, in the honest order:
//
//   1. THE INPUTS. A units surface where an operator confirms what each point
//      measures (suggested from the tag, never stored from it), and a link to
//      Configurations → Sites where the area / tariff / occupancy are typed
//      beside the address. Neither is invented here.
//   2. THE RATING, computed only where every input it needs is present.
//
// FOUR THINGS IT REFUSES TO DO:
//   • No default area, no estimated area, no national average. A site with no
//     area recorded says so and links to where to record it.
//   • No partial score. `blocked` is printed instead of a number.
//   • No invented band. BEE and IGBC thresholds are published documents this
//     deployment does not hold, so the EPI ships as a measured figure and the
//     absence of a band is stated with its reason, not left blank.
//   • No hidden arithmetic. Every meter's own subtraction, the days covered, the
//     annualisation factor and the division are all on screen. A number an
//     operator cannot audit is not a rating.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelList,
  PanelFooter,
  EmptyPane,
  InfoCell,
  Segmented,
  LoadingBlock,
  EstateHeader,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import UnitsPanel from "./components/UnitsPanel";
import BuildingFactsPanel from "./components/building/BuildingFactsPanel";
import { bi } from "./api";
import sitesApi from "@/lib/api/sites";

const RANGES = [
  { value: 30, label: "30D" },
  { value: 90, label: "90D" },
  { value: 365, label: "1Y" },
];

const TABS = [
  { value: "rating", label: "RATING" },
  { value: "units", label: "UNITS" },
  // The EPI's own denominator, recorded where it is used. It was a "Building"
  // tab on the Sites console — beside the address, in a console that reads none
  // of these numbers, while THIS screen showed them read-only and linked back
  // there. One fact, one surface, and this is the surface that consumes it.
  { value: "building", label: "BUILDING" },
];

const num = (v: any, digits = 1) =>
  typeof v === "number" && Number.isFinite(v)
    ? v.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "—";

export default function Ratings() {
  const [siteId, setSiteId] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState("rating");
  const [meters, setMeters] = useState<string[]>([]);

  const sitesQ = useQuery<any>({
    queryKey: ["bi-rating-sites"],
    queryFn: () => bi.ratingSites(),
    refetchInterval: 120_000,
  });
  const sites = sitesQ.data?.items || [];


  // The explicit choice, or the first row once the list lands. Derived rather
  // than synced in an effect, which rendered one empty frame first.
  const effectiveSiteId = siteId ?? sites[0]?.site_id ?? null;

  const site = sites.find((s: any) => s.site_id === effectiveSiteId) || null;

  // Candidate meters: points AT THIS SITE that an operator has confirmed are
  // kWh registers. Read from the units surface — same source of truth, so a unit
  // confirmed on the other tab shows up here without a second concept.
  const confirmedQ = useQuery<any>({
    queryKey: ["bi-units", "confirmed", "all"],
    queryFn: () => bi.units({ confirmed: "confirmed", limit: 1000 }),
  });
  const candidates = useMemo(
    () =>
      (confirmedQ.data?.items || []).filter(
        (r: any) =>
          r.site_id === effectiveSiteId &&
          r.type === "num" &&
          String(r.unit || "").trim().toLowerCase() === "kwh",
      ),
    [confirmedQ.data, effectiveSiteId],
  );

  // A site change drops a selection that belonged to the previous site.
  useEffect(() => {
    setMeters([]);
  }, [effectiveSiteId]);

  // The full site row, for the BUILDING tab. The rating list carries the three
  // headline numbers but not the emission factors or the tariff slabs, and the
  // form writes back to `sites` — so it needs the record it is editing, not a
  // projection of it. Fetched only when that tab is open.
  const siteRowQ = useQuery({
    queryKey: ["site", effectiveSiteId],
    queryFn: () => sitesApi.get(effectiveSiteId as string),
    enabled: !!effectiveSiteId && tab === "building",
  });

  const ratingQ = useQuery<any>({
    queryKey: ["bi-rating", effectiveSiteId, days, meters.join(",")],
    queryFn: () => bi.rating({ site_id: effectiveSiteId, point_id: meters, days }),
    enabled: !!effectiveSiteId,
  });
  const r = ratingQ.data;

  return (
    <ConsolePage>
      <EstateHeader
        crumbs={[{ label: "Ratings" }]}
        desc="EPI = annualised kWh / gross floor area — computed only where every input exists. Both inputs are supplied here: what each point measures on UNITS, and the area, tariff and occupancy on BUILDING. Nothing is defaulted, and a missing input renders its reason instead of a number."
      />
      <ConsoleGrid cols="xl:grid-cols-[25%_1fr]">
        {/* ── sites ───────────────────────────────────────────────── */}
        <ConsolePanel>
          <PanelHeader icon="heroicons:star" title="Sites" count={sites.length || ""} />
          <PanelList
            loading={sitesQ.isLoading}
            error={sitesQ.error ? apiError(sitesQ.error, "Could not load sites") : null}
            empty={!sites.length}
            emptyText="No site has reached this store yet"
          >
            {sites.map((s: any) => {
              const on = s.site_id === effectiveSiteId;
              const rated = s.gross_floor_area_sqm != null;
              return (
                <button
                  key={s.site_id}
                  type="button"
                  onClick={() => setSiteId(s.site_id)}
                  className={`w-full rounded-[10px] border px-3 py-2 text-left transition ${
                    on
                      ? "border-[rgba(251,191,36,.5)] bg-[rgba(251,191,36,.1)]"
                      : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
                  }`}
                >
                  <div className="truncate text-[12.5px] text-nb-ink">{s.site_name || s.site_id}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px]">
                    <span className={rated ? "text-nb-good" : "text-nb-warn"}>
                      {rated ? `${num(s.gross_floor_area_sqm, 0)} m²` : "no area recorded"}
                    </span>
                    <span className="font-mono text-nb-faint">{s.points} pts</span>
                    <span
                      className={`font-mono ${s.kwh_points ? "text-nb-soft" : "text-nb-faint"}`}
                      title="points confirmed as kWh registers"
                    >
                      {s.kwh_points} kWh
                    </span>
                  </div>
                </button>
              );
            })}
          </PanelList>
          <PanelFooter>
            <p className="text-[10.5px] leading-relaxed text-nb-faint">
              A site is listed because core told this store about it. Its area, tariff and occupancy
              are recorded on the BUILDING tab — nothing here infers them.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* ── rating ──────────────────────────────────────────────── */}
        <ConsolePanel>
          {!site ? (
            <EmptyPane
              icon="heroicons:star"
              title="No site selected"
              subtitle="Pick a site to see what it would take to rate it"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <header className="flex flex-wrap items-start justify-between gap-3 border-b border-nb-line px-5 py-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-nb-ink">{site.site_name}</h2>
                  <p className="mt-0.5 text-xs text-nb-faint">
                    Energy performance index · kWh per m² per year
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented value={tab} onChange={setTab} options={TABS} />
                  {tab === "rating" && (
                    <Segmented value={days} onChange={setDays} options={RANGES} />
                  )}
                </div>
              </header>

              {tab === "units" ? (
                <div className="px-5 py-4">
                  <UnitsPanel />
                </div>
              ) : tab === "building" ? (
                <div className="px-5 py-4">
                  {siteRowQ.isLoading ? (
                    <LoadingBlock label="Loading site…" />
                  ) : siteRowQ.error ? (
                    // A failed read must not render an empty form: saving it
                    // would write blanks over numbers that are actually there.
                    <p className="text-[12px] text-nb-crit">
                      {apiError(siteRowQ.error, "Couldn't load this site's record")}
                    </p>
                  ) : siteRowQ.data ? (
                    <BuildingFactsPanel site={siteRowQ.data} />
                  ) : null}
                </div>
              ) : (
                <div className="space-y-3 px-5 py-4">
                  {/* ── the inputs, always visible ─────────────────── */}
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <InfoCell
                      label="Gross floor area"
                      value={
                        site.gross_floor_area_sqm != null
                          ? `${num(site.gross_floor_area_sqm, 0)} m²`
                          : "not recorded"
                      }
                      mono
                    />
                    <InfoCell
                      label="Tariff"
                      value={
                        site.energy_tariff_per_kwh != null
                          ? `${site.energy_tariff_per_kwh} ${site.tariff_currency || ""}/kWh`
                          : "not recorded"
                      }
                      mono
                    />
                    <InfoCell
                      label="Occupancy"
                      value={site.occupancy != null ? String(site.occupancy) : "not recorded"}
                      mono
                    />
                    <InfoCell
                      label="Facts asserted"
                      value={
                        site.facts_updated_at ? fmtRelative(site.facts_updated_at) : "never"
                      }
                    />
                  </div>

                  {/* ── meter selection ────────────────────────────── */}
                  <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                      Meters counted
                    </div>
                    {confirmedQ.isLoading ? (
                      <LoadingBlock label="Loading confirmed registers…" />
                    ) : !candidates.length ? (
                      <p className="text-[11.5px] leading-relaxed text-nb-faint">
                        No point at this site has a <b>confirmed</b> kWh unit yet. A rating counts
                        only registers somebody has confirmed are kilowatt-hours — the source sends
                        no unit, so nothing can be added up until then. Open the{" "}
                        <button
                          type="button"
                          onClick={() => setTab("units")}
                          className="text-nb-blueb underline"
                        >
                          UNITS
                        </button>{" "}
                        tab to record them.
                      </p>
                    ) : (
                      <>
                        <div className="flex flex-wrap gap-1.5">
                          {candidates.map((c: any) => {
                            const on = meters.includes(c.point_id);
                            return (
                              <button
                                key={c.point_id}
                                type="button"
                                onClick={() =>
                                  setMeters((m) =>
                                    on ? m.filter((x) => x !== c.point_id) : [...m, c.point_id],
                                  )
                                }
                                className={`flex items-center gap-1.5 rounded-[7px] border px-2 py-1 text-[11px] transition ${
                                  on
                                    ? "border-[rgba(251,191,36,.55)] bg-[rgba(251,191,36,.12)] text-nb-ink"
                                    : "border-nb-line bg-[rgba(6,11,26,.5)] text-nb-soft hover:border-nb-blue"
                                }`}
                              >
                                <Icon
                                  icon={on ? "heroicons:check-circle-solid" : "heroicons:plus-circle"}
                                  className="text-[13px]"
                                />
                                <span className="max-w-[220px] truncate">
                                  {c.device_tag} / {c.point_tag}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                          Choose the registers that make up this site&apos;s incoming supply. The
                          platform holds no fact saying which meter that is: picking one from its
                          tag would be a guess, and adding every confirmed register would count an
                          incomer twice against its own sub-meters. So it is your call, and it is
                          shown beside the score.
                        </p>
                      </>
                    )}
                  </div>

                  {ratingQ.isLoading || !r ? (
                    <LoadingBlock label="Reading the rollup…" />
                  ) : (
                    <>
                      {/* ── the score, or the reasons there is none ─── */}
                      {r.epi ? (
                        <div className="rounded-[12px] border border-[rgba(251,191,36,.35)] bg-[rgba(251,191,36,.07)] p-4">
                          <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
                            Energy performance index
                          </p>
                          <p className="mt-1 font-mono text-[34px] leading-none text-nb-ink">
                            {num(r.epi.epi_kwh_per_sqm_year)}
                          </p>
                          <p className="mt-1 text-[11.5px] text-nb-soft">kWh / m² / year</p>
                          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                            <InfoCell
                              label="Measured"
                              value={`${num(r.epi.measured_kwh)} kWh`}
                              mono
                            />
                            <InfoCell
                              label="Days covered"
                              value={num(r.epi.days_covered, 2)}
                              mono
                            />
                            <InfoCell
                              label="Annualised"
                              value={`${num(r.epi.annualised_kwh)} kWh/yr`}
                              mono
                            />
                            <InfoCell label="Area" value={`${num(r.epi.area_sqm, 0)} m²`} mono />
                          </div>
                          <p className="mt-3 rounded-[8px] border border-nb-line bg-[rgba(6,11,26,.55)] px-3 py-2 font-mono text-[11px] leading-relaxed text-nb-soft">
                            {r.epi.formula}
                          </p>
                          {r.epi.annualisation_factor > 2 && (
                            <p className="mt-2 text-[11px] leading-relaxed text-nb-warn">
                              This figure is annualised from {num(r.epi.days_covered, 2)} days of
                              readings — a ×{num(r.epi.annualisation_factor)} extrapolation. It is a
                              projection of what was measured, not a year that was measured.
                            </p>
                          )}
                          <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                            {r.resolution_reason}
                          </p>
                        </div>
                      ) : (
                        <div className="rounded-[12px] border border-dashed border-[rgba(251,191,36,.4)] bg-[rgba(6,11,26,.4)] p-4">
                          <div className="flex items-center gap-2">
                            <Icon
                              icon="heroicons:no-symbol"
                              className="shrink-0 text-[18px] text-nb-warn"
                            />
                            <p className="text-[13px] font-semibold text-nb-ink">
                              Cannot rate this site
                            </p>
                          </div>
                          <ul className="mt-2 space-y-1.5">
                            {r.blocked.map((b: string, i: number) => (
                              <li
                                key={i}
                                className="text-[11.5px] leading-relaxed text-nb-soft before:mr-1.5 before:text-nb-faint before:content-['·']"
                              >
                                {b}
                              </li>
                            ))}
                          </ul>
                          {site.gross_floor_area_sqm == null && (
                            // Was a link to Configurations → Sites. The form is
                            // on this screen now, so the fix is one click from
                            // the sentence that says what is missing.
                            <button
                              type="button"
                              onClick={() => setTab("building")}
                              className="mt-3 inline-flex items-center gap-1.5 rounded-[7px] border border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)] px-2.5 py-1 text-[11.5px] text-nb-blueb transition hover:bg-[rgba(96,165,250,.2)]"
                            >
                              <Icon icon="heroicons:arrow-right-circle" className="text-[14px]" />
                              Record the area on the BUILDING tab
                            </button>
                          )}
                          <p className="mt-3 text-[10.5px] leading-relaxed text-nb-faint">
                            No partial score is shown, and no figure is substituted for a missing
                            one. An EPI computed against a defaulted area would look exactly like a
                            real one.
                          </p>
                        </div>
                      )}

                      {/* ── cost, only when a tariff was recorded ───── */}
                      {r.cost && (
                        <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                            Cost of the measured window
                          </div>
                          <p className="font-mono text-[20px] leading-none text-nb-ink">
                            {num(r.cost.amount, 2)} {r.cost.currency}
                          </p>
                          <p className="mt-1.5 font-mono text-[10.5px] text-nb-faint">
                            {r.cost.formula}
                          </p>
                        </div>
                      )}

                      {/* ── the meters' arithmetic ──────────────────── */}
                      {r.meters.length > 0 && (
                        <div>
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                            How each meter contributed
                          </div>
                          <div className="overflow-x-auto rounded-[10px] border border-nb-line">
                            <table className="w-full min-w-[700px] text-left">
                              <thead>
                                <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                                  <th className="px-3 py-2 font-semibold">Meter</th>
                                  <th className="px-3 py-2 text-right font-semibold">First</th>
                                  <th className="px-3 py-2 text-right font-semibold">Last</th>
                                  <th className="px-3 py-2 text-right font-semibold">Buckets</th>
                                  <th className="px-3 py-2 text-right font-semibold">kWh</th>
                                  <th className="px-3 py-2 font-semibold">Working</th>
                                </tr>
                              </thead>
                              <tbody>
                                {r.meters.map((m: any) => (
                                  <tr key={m.point_id} className="border-t border-nb-line/50">
                                    <td className="px-3 py-1.5 text-[11.5px] text-nb-ink">
                                      <span className="text-nb-soft">{m.device_tag}</span>
                                      <span className="text-nb-faint"> / </span>
                                      <span className="font-mono">{m.point_tag}</span>
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                      {num(m.first_value, 2)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                      {num(m.last_value, 2)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                      {m.buckets}
                                    </td>
                                    <td
                                      className={`px-3 py-1.5 text-right font-mono text-[12px] ${
                                        m.status === "ok" ? "text-nb-ink" : "text-nb-warn"
                                      }`}
                                    >
                                      {m.status === "ok" ? num(m.consumption_kwh, 2) : "—"}
                                    </td>
                                    <td className="px-3 py-1.5 text-[10.5px] leading-relaxed text-nb-faint">
                                      {m.reason}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                            A kWh point is a lifetime counter, so consumption is last − first over
                            the window, read from the hourly rollup. A register that went DOWN spans
                            a reset, a rollover or a device swap and contributes nothing — never an
                            absolute value. A register that did not move contributes zero, which is
                            a measurement, not a fault.
                          </p>
                        </div>
                      )}

                      {/* ── the band — or the exact input still missing ── */}
                      <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <Icon
                            icon="heroicons:academic-cap"
                            className="text-[15px] text-nb-faint"
                          />
                          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                            Benchmark band
                          </div>
                          {r.benchmark.available ? (
                            <span
                              className="rounded-[5px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] px-1.5 py-0.5 text-[9.5px] uppercase tracking-[.6px] text-nb-blueb"
                              title={r.benchmark.citation || undefined}
                            >
                              {r.benchmark.standard} · {r.benchmark.version}
                            </span>
                          ) : (
                            <span className="rounded-[5px] border border-nb-line px-1.5 py-0.5 text-[9.5px] uppercase tracking-[.6px] text-nb-faint">
                              none loaded
                            </span>
                          )}
                        </div>
                        {r.benchmark.band ? (
                          <div className="mb-2 flex items-center gap-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
                            <span className="font-mono text-[22px] leading-none text-nb-ink">
                              {r.benchmark.band.stars}★
                            </span>
                            <span className="text-[11px] leading-relaxed text-nb-soft">
                              band{" "}
                              {r.benchmark.band.min != null
                                ? `${r.benchmark.band.min}–${r.benchmark.band.max}`
                                : `below ${r.benchmark.band.max}`}{" "}
                              {r.benchmark.band_unit} ·{" "}
                              {/* jan-2022 resolves to a size category + AC-share
                                  percentage; feb-2009 to a zone + AC category.
                                  The server states the resolved context either
                                  way — print it, fall back to the 2009 pair. */}
                              {r.benchmark.context ??
                                `zone ${r.benchmark.zone} · ${r.benchmark.ac_category}`}
                            </span>
                          </div>
                        ) : null}
                        <p className="text-[11.5px] leading-relaxed text-nb-soft">
                          {r.benchmark.reason}
                        </p>
                        {r.benchmark.what_it_needs && (
                          <p className="mt-1.5 text-[10.5px] leading-relaxed text-nb-faint">
                            What it would take: {r.benchmark.what_it_needs}
                          </p>
                        )}
                        {r.benchmark.citation && (
                          <p className="mt-1.5 break-words text-[10px] leading-relaxed text-nb-faint">
                            Citation: {r.benchmark.citation}
                          </p>
                        )}
                      </div>

                      {/* ── baseline: the rule, and the honest day count ── */}
                      {r.baseline && (
                        <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                          <div className="mb-1.5 flex items-center gap-2">
                            <Icon
                              icon="heroicons:calendar-days"
                              className="text-[15px] text-nb-faint"
                            />
                            <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                              Vs baseline
                            </div>
                            <span className="rounded-[5px] border border-nb-line px-1.5 py-0.5 text-[9.5px] uppercase tracking-[.6px] text-nb-faint">
                              {r.baseline.rule}
                            </span>
                          </div>
                          <p className="text-[11.5px] leading-relaxed text-nb-soft">
                            {r.baseline.reason}
                          </p>
                          <p className="mt-1.5 text-[10.5px] leading-relaxed text-nb-faint">
                            {r.baseline.statement}
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
