"use client";

// One category of the estate — the shared console behind BOTH built Sense tiles:
//   Energy & Metering  (category=energy)   HVAC & Assets  (category=hvac)
//
// They are the same screen with a different filter because the store makes them
// the same shape: a device with a classification, some points, and a value per
// point. Two copies would drift; one component with a `category` prop cannot.
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

import DeltaT, { hasDeltaT } from "./components/DeltaT";
import TrendChart from "./components/TrendChart";
import { bi } from "./api";
import { categoryMeta, deviceTypeLabel, fmtReading, qualityTone } from "./constants";

const RANGES = [
  { value: 1, label: "1H" },
  { value: 6, label: "6H" },
  { value: 24, label: "24H" },
  { value: 168, label: "7D" },
];

export default function CategoryConsole({ category }: { category: string }) {
  const meta = categoryMeta(category);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pointId, setPointId] = useState<string | null>(null);
  const [hours, setHours] = useState(6);

  const devicesQ = useQuery<any>({
    queryKey: ["bi-devices", category],
    queryFn: () => bi.devices({ category, limit: 500 }),
    refetchInterval: 60_000,
  });

  const devices = devicesQ.data?.items || [];

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
  useEffect(() => {
    if (!deviceId && filtered.length) setDeviceId(filtered[0].device_id);
  }, [filtered, deviceId]);

  const selected = devices.find((d: any) => d.device_id === deviceId) || null;

  const pointsQ = useQuery<any>({
    queryKey: ["bi-points", deviceId],
    queryFn: () => bi.points({ device_id: deviceId, with_latest: true, limit: 500 }),
    enabled: !!deviceId,
    // Values are LIVE — the API reads raw for these, so polling them is the point.
    refetchInterval: 20_000,
  });

  const points = pointsQ.data?.items || [];

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

  return (
    <ConsolePage>
      <ConsoleGrid cols="xl:grid-cols-[320px_1fr]">
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
            emptyText="No device in this category has reported"
          >
            {filtered.map((d: any) => {
              const on = d.device_id === deviceId;
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
            <p className="text-[10.5px] leading-relaxed text-nb-faint">
              A device is listed because it has REPORTED. The store has no configuration side —
              the reading-writer creates a row from a reading, never from a device list.
            </p>
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
                    deviceId={selected.device_id}
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
                    <p className="mt-2 text-[10.5px] leading-relaxed text-nb-faint">
                      {seriesQ.data.resolution_reason}. Shaded band is each bucket&apos;s min→max, the
                      line is its average. No unit — the source reports none.
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
