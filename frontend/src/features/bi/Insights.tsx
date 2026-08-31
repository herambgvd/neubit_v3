"use client";

// Building Intelligence → INSIGHTS & CORRELATION.
//
// WHY THIS TILE IS BUILT, when the launcher used to say it could not be.
// The old reason was that "a correlation would be between two unnamed numbers".
// That was wrong on both halves:
//
//   • Pearson's r is DIMENSIONLESS. It is a covariance divided by two standard
//     deviations, so whatever units the two series have cancel out. A missing
//     `points.unit` blocks a RATING (kWh per m² is a unit statement); it does
//     not block a coefficient.
//   • The series are not unnamed. Each one carries `device_tag` and `point_tag`
//     — the SOURCE's own labels, stored exactly as sent. "4F Khem Chiller01 /
//     IWT against B1-2F4-Sump Pump1 / KW_L1" names both sides in the building's
//     own vocabulary.
//
// So the coefficient is honest. What is NOT honest is INTERPRETING it, and this
// screen supplies no interpretation: it never says one thing drives another, it
// never ranks causes, it never uses the word "because". That warning is on the
// screen, not only in this comment — see the banner below — because a caption a
// developer reads is not a caption an operator reads.
//
// FOUR THINGS THE SCREEN MUST SHOW, and does:
//   1. WHICH STORE answered. Correlation reads the rollups (`readings_1m` /
//      `readings_1h`), never the raw hypertable, and the server's own
//      `resolution_reason` is printed verbatim. There is no raw option to
//      downgrade to and none is offered.
//   2. n, beside every coefficient. Two series correlate only over the buckets
//      they BOTH filled; a +0.98 over 4 buckets is noise and the reader must be
//      able to see that without asking.
//   3. UNDEFINED, not zero. A series with one distinct value has zero variance,
//      so r does not exist. Three of the four chillers and every energy point on
//      this deployment are frozen right now, so this is the normal case here.
//   4. ABSENCE, as absence. A pair whose buckets never met says so.
//
// Everything on this screen is computed from stored readings by the server. There
// is no score, no index and no placeholder panel.
import { useEffect, useMemo, useState } from "react";
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
} from "@/components/console";
import { apiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

import CorrelationMatrix, { fmtR } from "./components/CorrelationMatrix";
import Scatter from "./components/Scatter";
import { bi } from "./api";
import { categoryMeta, fmtReading } from "./constants";

const ACCENT = "#a78bfa";
const MAX_SERIES = 12;

const RANGES = [
  { value: 24, label: "24H" },
  { value: 168, label: "7D" },
  { value: 720, label: "30D" },
];

interface Sel {
  point_id: string;
  point_tag: string;
  device_tag: string;
  category: string | null;
}

export default function Insights() {
  const [search, setSearch] = useState("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Sel[]>([]);
  const [hours, setHours] = useState(168);
  const [pair, setPair] = useState<[string, string] | null>(null);

  // Every device that has reported, in every category — a correlation is only
  // interesting across the boundaries the category consoles draw.
  const devicesQ = useQuery<any>({
    queryKey: ["bi-devices", "all"],
    queryFn: () => bi.devices({ limit: 500 }),
    refetchInterval: 120_000,
  });
  const devices = devicesQ.data?.items || [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return devices.filter((d: any) => !term || (d.device_tag || "").toLowerCase().includes(term));
  }, [devices, search]);

  useEffect(() => {
    if (!deviceId && filtered.length) setDeviceId(filtered[0].device_id);
  }, [filtered, deviceId]);

  const pointsQ = useQuery<any>({
    queryKey: ["bi-points", deviceId],
    queryFn: () => bi.points({ device_id: deviceId, with_latest: true, limit: 500 }),
    enabled: !!deviceId,
    refetchInterval: 60_000,
  });
  const points = pointsQ.data?.items || [];
  const device = devices.find((d: any) => d.device_id === deviceId) || null;

  const ids = selected.map((s) => s.point_id);
  const idsKey = ids.join(",");

  const corrQ = useQuery<any>({
    queryKey: ["bi-correlation", idsKey, hours],
    queryFn: () => bi.correlation({ point_id: ids, hours }),
    enabled: ids.length >= 2,
    refetchInterval: 120_000,
  });

  // The scatter comes from a SECOND call with exactly the two ids of the chosen
  // pair, because that is what makes the server return the aligned samples. The
  // coefficient in the detail panel comes from THAT call too, so the picture and
  // the number are one query's output and cannot drift from each other.
  const pairQ = useQuery<any>({
    queryKey: ["bi-correlation-pair", pair?.[0], pair?.[1], hours],
    queryFn: () => bi.correlation({ point_id: pair, hours }),
    enabled: !!pair,
    refetchInterval: 120_000,
  });

  // Keep the detail pane pointed at something real: when the selection changes,
  // drop a pair that is no longer in it.
  useEffect(() => {
    if (pair && !(ids.includes(pair[0]) && ids.includes(pair[1]))) setPair(null);
  }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(p: any) {
    setSelected((cur) => {
      if (cur.some((s) => s.point_id === p.point_id))
        return cur.filter((s) => s.point_id !== p.point_id);
      if (cur.length >= MAX_SERIES) return cur;
      return [
        ...cur,
        {
          point_id: p.point_id,
          point_tag: p.point_tag,
          device_tag: device?.device_tag ?? p.device_tag ?? "",
          category: device?.category ?? null,
        },
      ];
    });
  }

  const corr = corrQ.data;
  const corrErr = corrQ.error ? apiError(corrQ.error, "Could not compute correlation") : null;

  const pairData = pairQ.data;
  const pairRow = pairData?.pairs?.[0] || null;
  const pairSeries: any[] = pairData?.series || [];
  const [pa, pb] = pairSeries;

  const label = (s: any) => `${s?.device_tag ?? "?"} / ${s?.point_tag ?? "?"}`;

  return (
    <ConsolePage>
      <ConsoleGrid cols="xl:grid-cols-[320px_1fr]">
        {/* ── series picker ───────────────────────────────────────── */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons:chart-pie"
            title="Series"
            count={`${selected.length}/${MAX_SERIES}`}
          />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search devices…" />
          <PanelList
            loading={devicesQ.isLoading}
            error={devicesQ.error ? apiError(devicesQ.error, "Could not load devices") : null}
            empty={!filtered.length}
            emptyText="No device has reported"
          >
            {filtered.map((d: any) => {
              const on = d.device_id === deviceId;
              const meta = categoryMeta(d.category);
              const chosen = selected.filter((s) => s.device_tag === d.device_tag).length;
              return (
                <div key={d.device_id || d.device_tag}>
                  <button
                    type="button"
                    onClick={() => setDeviceId(on ? null : d.device_id)}
                    className={`w-full rounded-[10px] border px-3 py-2 text-left transition ${
                      on
                        ? "border-[rgba(167,139,250,.5)] bg-[rgba(167,139,250,.12)]"
                        : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] text-nb-ink">{d.device_tag}</span>
                      {chosen > 0 && (
                        <span className="shrink-0 rounded-[5px] border border-[rgba(167,139,250,.5)] px-1 font-mono text-[9.5px] text-[#c4b5fd]">
                          {chosen}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-nb-faint">
                      <Icon icon={meta.icon} className="text-[12px]" style={{ color: meta.accent }} />
                      <span>{meta.label}</span>
                      <span className="font-mono">{d.points} pts</span>
                    </div>
                  </button>

                  {on && (
                    <div className="mt-1 space-y-0.5 pl-2">
                      {pointsQ.isLoading ? (
                        <LoadingBlock label="Loading points…" />
                      ) : (
                        points.map((p: any) => {
                          const picked = selected.some((s) => s.point_id === p.point_id);
                          // A TEXT point has no numeric series, so it has no
                          // correlation. It is shown, and disabled, rather than
                          // hidden: what cannot be asked is worth seeing.
                          const numeric = p.type === "num";
                          const full = !picked && selected.length >= MAX_SERIES;
                          return (
                            <button
                              key={p.point_id}
                              type="button"
                              disabled={!numeric || full}
                              onClick={() => toggle(p)}
                              title={
                                !numeric
                                  ? "text readings have no numeric series to correlate"
                                  : full
                                    ? `at most ${MAX_SERIES} series`
                                    : undefined
                              }
                              className={`flex w-full items-center gap-2 rounded-[7px] border px-2 py-1 text-left transition ${
                                picked
                                  ? "border-[rgba(167,139,250,.5)] bg-[rgba(167,139,250,.14)]"
                                  : "border-transparent hover:bg-white/5"
                              } ${!numeric || full ? "opacity-40" : ""}`}
                            >
                              <Icon
                                icon={picked ? "heroicons:check-circle-solid" : "heroicons:plus-circle"}
                                className="shrink-0 text-[13px]"
                                style={{ color: picked ? ACCENT : "#64748b" }}
                              />
                              <span className="flex-1 truncate font-mono text-[11.5px] text-nb-soft">
                                {p.point_tag}
                              </span>
                              <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">
                                {fmtReading(p.latest)}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </PanelList>
          <PanelFooter>
            <p className="text-[10.5px] leading-relaxed text-nb-faint">
              Pick two or more numeric points, from any device and any category. The coefficient
              needs no unit — Pearson&apos;s r is dimensionless — and each series is named by the
              tags the source itself sent.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* ── analysis ────────────────────────────────────────────── */}
        <ConsolePanel>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-nb-line px-5 py-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-nb-ink">
                  Insights &amp; Correlation
                </h2>
                <p className="mt-0.5 text-xs text-nb-faint">
                  Pearson correlation between measured series, over the buckets they both filled
                </p>
              </div>
              <Segmented
                value={hours}
                onChange={setHours}
                options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
              />
            </header>

            {/* THE STANDING WARNING. On the screen, not in a code comment. */}
            <div className="mx-5 mt-4 flex gap-2.5 rounded-[10px] border border-[rgba(167,139,250,.35)] bg-[rgba(167,139,250,.08)] px-3 py-2.5">
              <Icon icon="heroicons:exclamation-triangle" className="mt-[1px] shrink-0 text-[15px] text-[#c4b5fd]" />
              <p className="text-[11px] leading-relaxed text-nb-soft">
                <strong className="font-semibold text-nb-ink">
                  A correlation is not a cause.
                </strong>{" "}
                r measures whether two series moved together over the same buckets. It cannot say
                which one moved first, whether either moved the other, or whether a third thing
                moved both. Nothing on this screen ranks causes or explains a bill — it reports the
                coefficient, how many buckets it was computed over, and when it does not exist.
              </p>
            </div>

            {selected.length < 2 ? (
              <div className="px-5 py-10">
                <EmptyPane
                  icon="heroicons:chart-pie"
                  title="Pick two series"
                  subtitle="Choose points on the left — from one device or across categories — to compare them"
                />
              </div>
            ) : (
              <>
                {/* selection chips */}
                <div className="flex flex-wrap gap-1.5 px-5 pt-4">
                  {selected.map((s, i) => (
                    <button
                      key={s.point_id}
                      type="button"
                      onClick={() => setSelected((c) => c.filter((x) => x.point_id !== s.point_id))}
                      className="flex items-center gap-1.5 rounded-[7px] border border-[rgba(167,139,250,.4)] bg-[rgba(167,139,250,.1)] px-2 py-1 text-[11px] text-nb-soft transition hover:border-nb-bad"
                      title="Remove from the comparison"
                    >
                      <span className="font-mono text-[10px] text-nb-faint">{i + 1}</span>
                      <span className="max-w-[220px] truncate">
                        {s.device_tag} / {s.point_tag}
                      </span>
                      <Icon icon="heroicons:x-mark" className="text-[12px]" />
                    </button>
                  ))}
                </div>

                {corrErr ? (
                  <div className="px-5 py-6 text-[12px] text-nb-bad">{corrErr}</div>
                ) : corrQ.isLoading || !corr ? (
                  <div className="px-5 py-6">
                    <LoadingBlock label="Reading the rollup…" />
                  </div>
                ) : (
                  <>
                    {/* ── matrix ───────────────────────────────────── */}
                    <div className="px-5 pt-4">
                      <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                            Coefficient matrix
                          </div>
                          <span className="rounded-[5px] border border-nb-line px-1.5 py-0.5 font-mono text-[10px] text-nb-faint">
                            {corr.resolution} rollup
                          </span>
                        </div>
                        <CorrelationMatrix
                          series={corr.series}
                          pairs={corr.pairs}
                          selected={pair}
                          onSelect={(a, b) => setPair([a, b])}
                        />
                        <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                          {corr.resolution_reason}. Every cell carries the number of buckets{" "}
                          <span className="font-mono">n</span> the coefficient was computed over —
                          only buckets BOTH series filled count. <b>UNDEF</b> means one side
                          reported a single value across the overlap: its standard deviation is
                          zero, so r has no value. That is not a correlation of zero.{" "}
                          <b>NO OVERLAP</b> means the two never filled the same bucket. Fewer than{" "}
                          <span className="font-mono">{corr.min_buckets}</span> overlapping buckets
                          is reported as <b>n TOO LOW</b> rather than as a coefficient. Click a cell
                          for the pair.
                        </p>
                      </div>
                    </div>

                    {/* ── the chosen pair ──────────────────────────── */}
                    <div className="px-5 pt-3">
                      <div className="rounded-[12px] border border-nb-line bg-[rgba(10,18,40,.45)] p-3">
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                          Pair detail
                        </div>
                        {!pair ? (
                          <p className="py-6 text-center text-[11.5px] text-nb-faint">
                            Pick a cell in the matrix above.
                          </p>
                        ) : pairQ.isLoading || !pairRow ? (
                          <LoadingBlock label="Aligning buckets…" />
                        ) : (
                          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
                            <div>
                              {pairRow.status === "ok" ? (
                                <Scatter
                                  samples={pairData.samples || []}
                                  xLabel={label(pa)}
                                  yLabel={label(pb)}
                                  accent={ACCENT}
                                />
                              ) : (
                                // No plot when there is no coefficient. A frozen
                                // series draws a straight stripe, which LOOKS like
                                // a finding; the reason is the honest render.
                                <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-nb-line px-6 text-center">
                                  <Icon
                                    icon="heroicons:no-symbol"
                                    className="text-[22px] text-nb-warn"
                                  />
                                  <p className="text-[12px] text-nb-soft">No coefficient exists</p>
                                  <p className="text-[11px] leading-relaxed text-nb-faint">
                                    {pairRow.reason}
                                  </p>
                                </div>
                              )}
                            </div>

                            <div className="space-y-2">
                              <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
                                <p className="text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
                                  Pearson r
                                </p>
                                <p className="mt-1 font-mono text-[26px] leading-none text-nb-ink">
                                  {pairRow.status === "ok" ? fmtR(pairRow.r) : "undefined"}
                                </p>
                                <p className="mt-1.5 text-[10.5px] leading-relaxed text-nb-faint">
                                  {pairRow.reason}
                                </p>
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <InfoCell label="Overlapping buckets" value={pairRow.n} mono />
                                <InfoCell label="Resolution" value={pairData.resolution} mono />
                                <InfoCell
                                  label="Overlap from"
                                  value={
                                    pairRow.overlap_start
                                      ? fmtRelative(pairRow.overlap_start)
                                      : "no overlap"
                                  }
                                />
                                <InfoCell
                                  label="Overlap to"
                                  value={
                                    pairRow.overlap_end
                                      ? fmtRelative(pairRow.overlap_end)
                                      : "no overlap"
                                  }
                                />
                              </div>
                              {pairData.samples_truncated && (
                                <p className="text-[10px] text-nb-warn">
                                  Scatter truncated to the first {pairData.samples.length} aligned
                                  buckets; the coefficient above used all {pairRow.n}.
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ── per-series diagnostics ───────────────────── */}
                    <div className="px-5 py-3 pb-5">
                      <div className="mb-2 flex items-center justify-between">
                        <div className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
                          Series over this window
                        </div>
                        <span className="text-[10.5px] text-nb-faint">
                          read from {corr.resolution} buckets
                        </span>
                      </div>
                      <div className="overflow-x-auto rounded-[10px] border border-nb-line">
                        <table className="w-full min-w-[640px] text-left">
                          <thead>
                            <tr className="bg-[rgba(6,11,26,.6)] text-[10px] uppercase tracking-[1.2px] text-nb-faint">
                              <th className="px-3 py-2 font-semibold">#</th>
                              <th className="px-3 py-2 font-semibold">Series</th>
                              <th className="px-3 py-2 text-right font-semibold">Buckets</th>
                              <th className="px-3 py-2 text-right font-semibold">Distinct</th>
                              <th className="px-3 py-2 text-right font-semibold">Min</th>
                              <th className="px-3 py-2 text-right font-semibold">Mean</th>
                              <th className="px-3 py-2 text-right font-semibold">Max</th>
                              <th className="px-3 py-2 font-semibold">State</th>
                            </tr>
                          </thead>
                          <tbody>
                            {corr.series.map((s: any, i: number) => (
                              <tr key={s.point_id} className="border-t border-nb-line/50">
                                <td className="px-3 py-1.5 font-mono text-[11px] text-nb-faint">
                                  {i + 1}
                                </td>
                                <td className="px-3 py-1.5 text-[11.5px] text-nb-ink">
                                  <span className="text-nb-soft">{s.device_tag}</span>
                                  <span className="text-nb-faint"> / </span>
                                  <span className="font-mono">{s.point_tag}</span>
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                  {s.buckets}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                  {s.distinct_values}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                  {fmtReading(s.min === null ? null : { num: s.min })}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                  {fmtReading(s.mean === null ? null : { num: s.mean })}
                                </td>
                                <td className="px-3 py-1.5 text-right font-mono text-[11.5px] text-nb-soft">
                                  {fmtReading(s.max === null ? null : { num: s.max })}
                                </td>
                                <td className="px-3 py-1.5 text-[11px]">
                                  {s.buckets === 0 ? (
                                    <span className="text-nb-faint">
                                      no numeric bucket in window
                                    </span>
                                  ) : s.frozen ? (
                                    <span className="text-nb-warn">
                                      frozen — one value, r undefined
                                    </span>
                                  ) : (
                                    <span className="text-nb-good">varies</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                        No unit is shown, and none is needed: r is dimensionless. Min / mean / max
                        are the numbers as measured. A FROZEN series is a real state of this estate,
                        not a display failure — a point that reported one value all window has no
                        standard deviation, so no correlation involving it exists.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}
