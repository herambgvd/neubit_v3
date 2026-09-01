"use client";

// Time-of-Use tariff slabs — the Building tab's second section.
//
// The scalar tariff above is the legitimate simple case; this editor exists for
// the site whose price changes with the clock (the BI mockup's Off-Peak /
// Normal / Peak strip). PRECEDENCE, stated wherever a number is entered: when
// any slab is in effect for a date, the slabs override the scalar ENTIRELY —
// an hour no slab covers has NO price (absence, never a fallback into the
// scalar). The scalar applies only when no slab set exists.
//
// RULES THIS EDITOR KEEPS:
//   • Save sends the WHOLE list (PUT, full replace) — so removing every row
//     and saving is a first-class retraction, after which the scalar applies.
//   • Coverage is CHECKED, never COMPLETED: gaps and overlaps in the 24h cycle
//     are warned about in words, and no filler slab is ever invented.
//   • Wrapping windows work: 22:00 → 06:00 crosses midnight.
//   • `effective_from` makes a revision a new generation of rows rather than a
//     silent rewrite of rates BI already priced with.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { FInput } from "./FormControls";
import { ActionButton, RowAction } from "@/components/console";
import { apiError } from "@/lib/api";
import sitesApi from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";

/** "22", "22:00", "22:30", "24:00" → minutes since midnight; null = unparseable. */
export function parseHHMM(v: string, { allow24 = false } = {}): number | null {
  const m = String(v || "").trim().match(/^(\d{1,2})(?::([0-5]\d))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2] || 0);
  if (h === 24) return allow24 && mins === 0 ? 1440 : null;
  if (h > 23) return null;
  return h * 60 + mins;
}

export function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Expand a window into [from, to) segments on the 0..1440 line. end < start
 *  wraps midnight; end === start is invalid and returns []. */
function segments(start: number, end: number): Array<[number, number]> {
  if (end > start) return [[start, end]];
  if (end < start) return [[start, 1440], [0, end]];
  return [];
}

/** Gaps and overlaps across the 24h cycle for ONE generation of slabs.
 *  Reported in words; nothing is filled in. */
export function coverage(rows: Array<{ start: number; end: number }>) {
  const count = new Array(1440).fill(0);
  for (const r of rows) for (const [a, b] of segments(r.start, r.end)) for (let i = a; i < b; i++) count[i]++;
  const ranges = (pred: (c: number) => boolean) => {
    const out: string[] = [];
    let from = -1;
    for (let i = 0; i <= 1440; i++) {
      const hit = i < 1440 && pred(count[i]);
      if (hit && from < 0) from = i;
      if (!hit && from >= 0) {
        out.push(`${toHHMM(from)}–${toHHMM(i)}`);
        from = -1;
      }
    }
    return out;
  };
  return { gaps: ranges((c) => c === 0), overlaps: ranges((c) => c > 1) };
}

type Row = {
  name: string;
  start: string; // HH:MM
  end: string; // HH:MM (24:00 allowed)
  rate: string;
  currency: string;
  effective_from: string; // YYYY-MM-DD
};

function fromApi(item: any): Row {
  return {
    name: item.name,
    start: toHHMM(item.start_minute),
    end: toHHMM(item.end_minute),
    rate: String(item.rate_per_kwh),
    currency: item.currency,
    effective_from: item.effective_from,
  };
}

function rowError(r: Row): string | null {
  if (!r.name.trim()) return "Every slab needs a name";
  const start = parseHHMM(r.start);
  const end = parseHHMM(r.end, { allow24: true });
  if (start === null) return `"${r.start || "…"}" is not a time (use HH:MM)`;
  if (end === null) return `"${r.end || "…"}" is not a time (use HH:MM, 24:00 for midnight)`;
  if (start === end)
    return "A window cannot start and end at the same minute — use 00:00 → 24:00 for a full day";
  const rate = Number(r.rate);
  if (!r.rate.trim() || !Number.isFinite(rate) || rate <= 0) return "Every slab needs a rate above zero";
  if (!r.currency.trim()) return "A rate needs a currency — a bare 8.5 is not a price";
  if (!r.effective_from) return "Every slab needs an effective-from date";
  return null;
}

export default function TariffSlabsEditor({ site }: any) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can("sites.update");

  const q = useQuery<any>({
    queryKey: ["site-tariff-slabs", site.site_id],
    queryFn: () => sitesApi.getTariffSlabs(site.site_id),
  });

  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (q.data) {
      setRows((q.data.items || []).map(fromApi));
      setDirty(false);
      setSaved(false);
      setErr(null);
    }
  }, [q.data, site.site_id]);

  const save = useMutation({
    mutationFn: () =>
      sitesApi.setTariffSlabs(
        site.site_id,
        rows.map((r) => ({
          name: r.name.trim(),
          start_minute: parseHHMM(r.start),
          end_minute: parseHHMM(r.end, { allow24: true }),
          rate_per_kwh: Number(r.rate),
          currency: r.currency.trim().toUpperCase(),
          effective_from: r.effective_from,
        })),
      ),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["site-tariff-slabs", site.site_id] });
    },
    onError: (e) => {
      setSaved(false);
      setErr(apiError(e, "Could not save the tariff slabs"));
    },
  });

  const set = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
    setSaved(false);
  };

  const errors = rows.map(rowError);
  const firstError = errors.find(Boolean) || null;

  // Coverage is judged per GENERATION (the newest effective_from among valid
  // rows — the set BI would price today with, once that date has arrived).
  const parsed = rows
    .map((r) => ({
      eff: r.effective_from,
      start: parseHHMM(r.start),
      end: parseHHMM(r.end, { allow24: true }),
    }))
    .filter((r) => r.eff && r.start !== null && r.end !== null && r.start !== r.end);
  const newest = parsed.reduce<string | null>((acc, r) => (acc && acc >= r.eff ? acc : r.eff), null);
  const current = parsed.filter((r) => r.eff === newest) as Array<{ start: number; end: number; eff: string }>;
  const cov = current.length ? coverage(current) : null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-nb-ink">Time-of-Use tariff slabs</h3>
        <p className="mt-0.5 text-xs text-nb-muted">
          When any slab is in effect, the slabs replace the flat tariff above <em>entirely</em> —
          an hour no slab covers has no price, and nothing falls back to the flat rate. The flat
          tariff applies only while this list is empty.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-xs text-nb-faint">Loading slabs…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-3 text-[11.5px] text-nb-faint">
          No slabs recorded. The flat tariff above (if any) prices consumption. Nothing here is
          pre-filled — a &ldquo;standard&rdquo; slab nobody stated would be an invented price.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-2 items-end gap-x-3 gap-y-2 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.4)] px-3 py-2.5 md:grid-cols-[1.4fr_.8fr_.8fr_.8fr_.7fr_1fr_auto]"
            >
              <FInput label="Slab name" value={r.name} onChange={(v: any) => set(i, { name: v })} placeholder="Off-Peak" />
              <FInput label="From" mono value={r.start} onChange={(v: any) => set(i, { start: v })} placeholder="22:00" />
              <FInput label="To" mono value={r.end} onChange={(v: any) => set(i, { end: v })} placeholder="06:00" />
              <FInput label="Rate / kWh" mono inputMode="decimal" value={r.rate} onChange={(v: any) => set(i, { rate: v })} placeholder="4.20" />
              <FInput label="Currency" value={r.currency} onChange={(v: any) => set(i, { currency: v })} placeholder="INR" />
              <FInput label="Effective from" type="date" value={r.effective_from} onChange={(v: any) => set(i, { effective_from: v })} />
              {editable && (
                <RowAction
                  icon="heroicons-outline:trash"
                  title="Remove slab"
                  onClick={() => {
                    setRows((prev) => prev.filter((_, j) => j !== i));
                    setDirty(true);
                    setSaved(false);
                  }}
                />
              )}
              {errors[i] && <p className="col-span-full text-[11px] text-nb-crit">{errors[i]}</p>}
            </div>
          ))}
        </div>
      )}

      {cov && (cov.gaps.length > 0 || cov.overlaps.length > 0) && (
        <div className="flex gap-2.5 rounded-[10px] border border-[rgba(251,191,36,.35)] bg-[rgba(251,191,36,.08)] px-3 py-2.5">
          <Icon icon="heroicons:exclamation-triangle" className="mt-[1px] shrink-0 text-[15px] text-nb-warn" />
          <div className="text-[11px] leading-relaxed text-nb-soft">
            {cov.gaps.length > 0 && (
              <p>
                <strong className="text-nb-ink">Not covered:</strong> {cov.gaps.join(", ")} — those
                hours will have <em>no price</em>. You can save anyway; nothing will invent a
                filler slab.
              </p>
            )}
            {cov.overlaps.length > 0 && (
              <p>
                <strong className="text-nb-ink">Covered twice:</strong> {cov.overlaps.join(", ")} —
                two slabs claim the same minutes in the current generation
                {newest ? ` (effective ${newest})` : ""}. Fix the boundaries before trusting a cost figure.
              </p>
            )}
          </div>
        </div>
      )}

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton
            icon="heroicons-outline:plus"
            onClick={() => {
              setRows((prev) => [
                ...prev,
                { name: "", start: "", end: "", rate: "", currency: prev[prev.length - 1]?.currency || "", effective_from: prev[prev.length - 1]?.effective_from || "" },
              ]);
              setDirty(true);
              setSaved(false);
            }}
            className="!px-3 !py-1.5 !text-xs"
          >
            Add slab
          </ActionButton>
          <ActionButton onClick={() => save.mutate()} disabled={save.isPending || !!firstError || !dirty} className="!px-3 !py-1.5 !text-xs">
            {save.isPending ? "Saving…" : "Save slabs"}
          </ActionButton>
          {saved && !save.isPending && (
            <span className="flex items-center gap-1 text-[11.5px] text-nb-good">
              <Icon icon="heroicons:check-circle" className="text-[14px]" /> Saved
            </span>
          )}
          {firstError && dirty && <span className="text-[11.5px] text-nb-crit">{firstError}</span>}
          {err && <span className="text-[11.5px] text-nb-crit">{err}</span>}
        </div>
      )}
      {!editable && (
        <p className="text-[11.5px] text-nb-faint">
          You do not hold <span className="font-mono">sites.update</span>, so the slabs are read-only here.
        </p>
      )}
    </section>
  );
}
