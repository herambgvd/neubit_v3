"use client";

// BI → Setup → ABOUT THE BUILDING: the few facts no sensor sends.
//
// What is missing leads, as work, each saying which figure stays off until it is
// answered; what is on file sits below as a record — the value, where it came
// from, when it was recorded — editable in place. Facts are few and long-lived,
// so seeing them together is worth more than a wizard once they are in, and the
// blocked ones leading keeps the first visit a worklist.
//
// Two columns the mirror still carries, occupancy and city, are asked for
// nowhere: nothing reads either. The tariff IS shown, recorded, with nothing
// reading it yet said plainly rather than implied away.
//
// Every write here is core's or the rating's, and two of them REPLACE a whole
// set — so `factsPut` and `factorsPut` send back what this screen does not ask
// about. That arithmetic is in record.ts, and it is tested.
import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { LoadingBlock } from "@/components/console";
import { apiError } from "@/lib/api";
import sitesApi from "@/lib/api/sites";
import type { SitePublic } from "@/lib/types";

import { bi } from "../../api";
import EmissionFactorsEditor from "../../components/building/EmissionFactorsEditor";
import TariffSlabsEditor from "../../components/building/TariffSlabsEditor";
import {
  benchmarkLine,
  blockedText,
  factorsPut,
  factsPut,
  readPercent,
  readPositive,
  readsText,
  zoneText,
  type Fact,
  type FactsRecord as Record_,
} from "./record";

const fmt = (v: number) => v.toLocaleString("en-GB", { maximumFractionDigits: 3 });
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : null;

export default function FactsRecord({
  siteId,
  mayWrite,
}: Readonly<{ siteId: string; mayWrite: boolean }>) {
  const qc = useQueryClient();
  const still = !!useReducedMotion();
  const [editing, setEditing] = useState<Fact["key"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const q = useQuery<Record_>({
    queryKey: ["bi-building-facts", siteId],
    queryFn: () => bi.buildingFacts(siteId),
  });
  // The two editors kept from the old form — slab-wise rates and the whole
  // factor list, each behind its own fact — take core's site record.
  const siteQ = useQuery<SitePublic>({
    queryKey: ["site", siteId],
    queryFn: () => sitesApi.get(siteId),
    enabled: mayWrite,
  });

  const done = () => {
    setEditing(null);
    setError(null);
    qc.invalidateQueries({ queryKey: ["bi-building-facts", siteId] });
    qc.invalidateQueries({ queryKey: ["bi-rating-sites"] });
    qc.invalidateQueries({ queryKey: ["bi-setup-checklist"] });
  };
  const fail = (e: unknown, what: string) => setError(apiError(e, what));

  const facts = useMutation({
    mutationFn: (change: Parameters<typeof factsPut>[1]) =>
      sitesApi.setBuildingFacts(siteId, factsPut(q.data!, change)),
    onSuccess: done,
    onError: (e) => fail(e, "Could not record it"),
  });
  const factor = useMutation({
    mutationFn: (added: { kg_co2_per_kwh: number; source: string; effective_from: string }) =>
      sitesApi.setEmissionFactors(
        siteId,
        factorsPut([...(q.data?.on_file ?? []), ...(q.data?.missing ?? [])].find((f) => f.key === "emission_factor"), added),
      ),
    onSuccess: done,
    onError: (e) => fail(e, "Could not record the carbon figure"),
  });
  const benchmark = useMutation({
    mutationFn: (body: { climate_zone?: string | null; ac_share_percent?: number | null }) =>
      bi.setBenchmarkConfig({ site_id: siteId, ...body }),
    onSuccess: done,
    onError: (e) => fail(e, "Could not record it"),
  });
  const busy = facts.isPending || factor.isPending || benchmark.isPending;

  if (q.error) {
    return <p className="pt-4 text-[12.5px] text-nb-crit">{apiError(q.error, "Could not read the record")}</p>;
  }
  // Not `isLoading`: a query can be pending with no data outside its first fetch
  // (a refetch after an invalidate, a remount off a cold cache), and reading the
  // record then threw on a live screen. The guard is on the DATA, not the flag.
  if (!q.data) return <LoadingBlock label="Reading the building's record…" />;
  const rec = q.data;
  if (!rec.known) {
    return (
      <p className="pt-6 text-[12.5px] text-nb-faint">
        Analytics has no record of this building yet — it appears here once its readings arrive.
      </p>
    );
  }

  const editor = (fact: Fact) => (
    <Editor
      fact={fact}
      rec={rec}
      busy={busy}
      onArea={(v) => facts.mutate({ area: v })}
      onTariff={(v, currency) => facts.mutate({ tariff: v, currency })}
      onFactor={(v) => factor.mutate(v)}
      onBenchmark={(v) => benchmark.mutate(v)}
      onCancel={() => {
        setEditing(null);
        setError(null);
      }}
      error={error}
    />
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[15px] font-semibold text-nb-ink">{rec.site_name || "This building"}</h2>
        <p className="text-[12.5px] text-nb-muted">
          {rec.totals.on_file} on file
          {rec.totals.missing ? ` · ${rec.totals.missing} waiting` : ""}
        </p>
        <p className="ml-auto text-[11.5px] text-nb-faint">Every answer is kept with where it came from</p>
      </div>

      {/* what is waiting — the work */}
      <div className="mt-4 space-y-3">
        {rec.missing.map((f) => (
          <div key={f.key} className="rounded-[13px] border border-nb-warn/30 bg-nb-warn/[.05] px-4 py-3.5">
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-nb-warn" />
                  <h3 className="text-[15px] font-semibold text-nb-ink">{titleOf(f)}</h3>
                  <span className="text-[11.5px] text-nb-faint">not on file</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-nb-soft">{f.why}</p>
                <p className="mt-1 text-[12.5px] text-nb-warn">{blockedText(f)}</p>
                {f.key === "benchmark" && f.standard && (
                  <p className="mt-1 text-[11.5px] text-nb-faint" title={f.source ?? undefined}>
                    {f.value} · {benchmarkLine(f) || "no inputs recorded"}
                  </p>
                )}
              </div>
              {mayWrite && editing !== f.key && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(f.key);
                    setError(null);
                  }}
                  className="h-9 shrink-0 rounded-[9px] bg-nb-blue px-4 text-[13px] font-medium text-white transition hover:bg-nb-blueb"
                >
                  Record it
                </button>
              )}
            </div>
            <AnimatePresence>
              {editing === f.key && (
                <motion.div
                  initial={still ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={still ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                  className="overflow-hidden"
                >
                  {editor(f)}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>

      {/* what is on file — the record */}
      {rec.on_file.length > 0 && (
        <div className="mt-5 overflow-hidden rounded-[13px] border border-nb-line">
          <div className="flex items-center gap-2.5 border-b border-white/[.06] bg-white/[.02] px-4 py-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-nb-ok" />
            <h3 className="text-[13.5px] font-semibold text-nb-ink">On file</h3>
            <span className="text-[12px] text-nb-faint">each one with where it came from</span>
          </div>
          {rec.on_file.map((f) => (
            <div key={f.key} className="border-t border-white/[.05] px-4 py-3 first:border-t-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="w-[210px] shrink-0 text-[13px] text-nb-soft">{titleOf(f)}</span>
                <span className="w-[150px] shrink-0 font-mono text-[13.5px] text-nb-ink">
                  {f.key === "benchmark" ? (f.standard ?? "—") : typeof f.value === "number" ? `${fmt(f.value)} ${f.unit ?? ""}` : (f.value ?? "—")}
                </span>
                <span className="min-w-0 flex-1 text-[12px] text-nb-faint">
                  {f.key === "benchmark" ? benchmarkLine(f) : detailOf(f)}
                </span>
                {mayWrite && editing !== f.key && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(f.key);
                      setError(null);
                    }}
                    className="h-8 shrink-0 rounded-[8px] border border-white/[.14] px-3 text-[12.5px] text-nb-soft transition hover:border-nb-blue/50 hover:text-nb-ink"
                  >
                    Change
                  </button>
                )}
              </div>
              {f.key === "tariff" && siteQ.data && mayWrite && (
                <details className="mt-2 rounded-[10px] border border-white/[.07] px-3 py-2">
                  <summary className="cursor-pointer list-none text-[12px] text-nb-muted hover:text-nb-ink">
                    Slab-wise rates, when the bill has them
                  </summary>
                  <div className="mt-2">
                    <TariffSlabsEditor site={siteQ.data} />
                  </div>
                </details>
              )}
              {f.key === "emission_factor" && siteQ.data && mayWrite && (
                <details className="mt-2 rounded-[10px] border border-white/[.07] px-3 py-2">
                  <summary className="cursor-pointer list-none text-[12px] text-nb-muted hover:text-nb-ink">
                    Every figure on file, and the years they apply from
                  </summary>
                  <div className="mt-2">
                    <EmissionFactorsEditor site={siteQ.data} />
                  </div>
                </details>
              )}
              {f.source && (
                <p className="mt-1 max-w-[860px] text-[11.5px] leading-relaxed text-nb-faint" title={f.source}>
                  {f.source.length > 160 ? `${f.source.slice(0, 160)}…` : f.source}
                </p>
              )}
              <AnimatePresence>
                {editing === f.key && (
                  <motion.div
                    initial={still ? false : { opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={still ? { opacity: 0 } : { opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="overflow-hidden"
                  >
                    {editor(f)}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      )}

      <p className="mt-4 text-[11.5px] text-nb-faint">
        Nothing else is asked for. A box nobody&apos;s figure reads is not a box worth filling.
      </p>
    </div>
  );
}

const titleOf = (f: Fact) => f.label;

function detailOf(f: Fact): string {
  const recorded = day(f.recorded_at);
  const reads = readsText(f.reads);
  if (!reads) return recorded ? `Recorded ${recorded} · nothing reads it yet` : "nothing reads it yet";
  return recorded ? `Recorded ${recorded} · ${reads} reads it` : `${reads} reads it`;
}

// ── the one editor, per fact ────────────────────────────────────────────────

function Editor({
  fact,
  rec,
  busy,
  error,
  onArea,
  onTariff,
  onFactor,
  onBenchmark,
  onCancel,
}: Readonly<{
  fact: Fact;
  rec: Record_;
  busy: boolean;
  error: string | null;
  onArea: (v: number) => void;
  onTariff: (v: number, currency: string) => void;
  onFactor: (v: { kg_co2_per_kwh: number; source: string; effective_from: string }) => void;
  onBenchmark: (v: { climate_zone?: string | null; ac_share_percent?: number | null }) => void;
  onCancel: () => void;
}>) {
  const [a, setA] = useState(fact.value != null && typeof fact.value === "number" ? String(fact.value) : "");
  const [currency, setCurrency] = useState(rec.carried.tariff_currency ?? "INR");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [zone, setZone] = useState(fact.climate_zone ?? "");
  const [share, setShare] = useState(fact.ac_share_percent != null ? String(fact.ac_share_percent) : "");
  const [local, setLocal] = useState<string | null>(null);

  const field =
    "h-9 rounded-[9px] border border-white/[.16] bg-transparent px-2.5 font-mono text-[13px] text-nb-ink outline-none focus:border-nb-blue/60";

  const save = () => {
    setLocal(null);
    if (fact.key === "area") {
      const v = readPositive(a);
      if (v === null) return setLocal("An area is a number of square metres.");
      return onArea(v);
    }
    if (fact.key === "tariff") {
      const v = readPositive(a);
      if (v === null) return setLocal("A rate is a number per unit.");
      return onTariff(v, currency.trim() || "INR");
    }
    if (fact.key === "emission_factor") {
      const v = readPositive(a);
      if (v === null) return setLocal("A carbon figure is a number of kg per unit.");
      if (!source.trim()) return setLocal("Say where the figure came from — a figure with no source is a guess.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from.trim())) return setLocal("Give the date it applies from, as 2025-04-01.");
      return onFactor({ kg_co2_per_kwh: v, source: source.trim(), effective_from: from.trim() });
    }
    // the benchmark: whichever input its version in force is missing
    if (fact.missing === "climate_zone" || (!fact.climate_zone && fact.zone_options?.length)) {
      if (!zone) return setLocal("Pick the climate zone the scheme publishes bands for.");
      return onBenchmark({ climate_zone: zone });
    }
    const v = readPercent(share);
    if (v === null) return setLocal("A share is between 0 and 100.");
    return onBenchmark({ ac_share_percent: v });
  };

  return (
    <div className="mt-3 border-t border-white/[.07] pt-3">
      {fact.key === "area" && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Floor area
            <span className="flex items-center gap-2">
              <input aria-label="Floor area" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} placeholder="40000" className={`${field} w-32 text-center`} />
              <span className="text-[13px] text-nb-soft">m²</span>
            </span>
          </label>
          <p className="max-w-[420px] text-[11.5px] text-nb-faint">
            Built-up area. The star scheme excludes basement parking — record what the scheme counts.
          </p>
        </div>
      )}

      {fact.key === "tariff" && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Rate per unit
            <input aria-label="Rate per unit" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} placeholder="10" className={`${field} w-28 text-center`} />
          </label>
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Currency
            <input aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={`${field} w-20 text-center`} />
          </label>
          <p className="max-w-[380px] text-[11.5px] text-nb-faint">
            A flat rate. Slab-wise rates are recorded on the building itself when the bill has them.
          </p>
        </div>
      )}

      {fact.key === "emission_factor" && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Carbon per unit
            <span className="flex items-center gap-2">
              <input aria-label="Carbon per unit" inputMode="decimal" value={a} onChange={(e) => setA(e.target.value)} placeholder="0.716" className={`${field} w-28 text-center`} />
              <span className="text-[13px] text-nb-soft">kg CO₂ / kWh</span>
            </span>
          </label>
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Applies from
            <input aria-label="Applies from" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="2025-04-01" className={`${field} w-32 text-center`} />
          </label>
          <label className="flex min-w-[260px] flex-1 flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Where it came from
            <input
              aria-label="Where it came from"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="CEA CO2 Baseline Database, version 20.0"
              className="h-9 rounded-[9px] border border-white/[.16] bg-transparent px-2.5 text-[13px] text-nb-ink outline-none focus:border-nb-blue/60"
            />
          </label>
        </div>
      )}

      {fact.key === "benchmark" && (
        <div className="flex flex-wrap items-end gap-3">
          {(fact.zone_options?.length ?? 0) > 0 && (
            <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
              Climate zone
              <select aria-label="Climate zone" value={zone} onChange={(e) => setZone(e.target.value)} className="h-9 rounded-[9px] border border-white/[.16] bg-transparent px-2 text-[13px] text-nb-blueb outline-none">
                <option value="">not recorded</option>
                {fact.zone_options!.map((z) => (
                  <option key={z} value={z}>
                    {zoneText(z)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex flex-col gap-1.5 text-[11.5px] text-nb-muted">
            Air-conditioned share
            <span className="flex items-center gap-2">
              <input aria-label="Air-conditioned share" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} placeholder="78" className={`${field} w-24 text-center`} />
              <span className="text-[13px] text-nb-soft">% of the floor</span>
            </span>
          </label>
          <p className="max-w-[360px] text-[11.5px] text-nb-faint">
            A rough share off the drawings is enough — it is kept as your statement, not as a measurement.
          </p>
        </div>
      )}

      {(local || error) && <p className="mt-2.5 text-[12.5px] text-nb-crit">{local || error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="h-9 rounded-[9px] bg-nb-blue px-4 text-[13px] font-medium text-white transition hover:bg-nb-blueb disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="h-9 px-3 text-[13px] text-nb-muted transition hover:text-nb-ink">
          Cancel
        </button>
      </div>
    </div>
  );
}
