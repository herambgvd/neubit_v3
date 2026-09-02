"use client";

// Grid emission factors — the Building tab's third section.
//
// A CO2 figure is measured kWh × a factor SOMEBODY PUBLISHED. The number is
// useless without knowing who: a factor with no citation is an invented figure
// wearing a real kWh's credibility, which is exactly the fabrication this
// platform forbids. So `source` is REQUIRED on every row, end to end — the
// server refuses a factor without one and the mirror refuses to carry one that
// lost its source in transit.
//
// `effective_from` makes a grid-mix revision a NEW row rather than a rewrite
// of history (one factor per date; two on the same date is a contradiction).
// Save is a PUT of the whole list; an empty list is a first-class retraction.
// Nothing is pre-filled: there is no "standard" or "national" factor here.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { FInput } from "./FormControls";
import { ActionButton, RowAction } from "@/components/console";
import { apiError } from "@/lib/api";
import sitesApi from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";

type Row = {
  value: string; // kg CO2 per kWh
  source: string;
  effective_from: string; // YYYY-MM-DD
};

function rowError(r: Row): string | null {
  const v = Number(r.value);
  if (!r.value.trim() || !Number.isFinite(v) || v <= 0)
    return "The factor must be a number above zero (kg CO₂ per kWh)";
  if (r.source.trim().length < 3)
    return "Every factor needs its source — where does this number come from?";
  if (!r.effective_from) return "Every factor needs an effective-from date";
  return null;
}

export default function EmissionFactorsEditor({ site }: any) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const editable = can("sites.update");

  const q = useQuery<any>({
    queryKey: ["site-emission-factors", site.site_id],
    queryFn: () => sitesApi.getEmissionFactors(site.site_id),
  });

  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (q.data) {
      setRows(
        (q.data.items || []).map((f: any) => ({
          value: String(f.kg_co2_per_kwh),
          source: f.source,
          effective_from: f.effective_from,
        })),
      );
      setDirty(false);
      setSaved(false);
      setErr(null);
    }
  }, [q.data, site.site_id]);

  const save = useMutation({
    mutationFn: () =>
      sitesApi.setEmissionFactors(
        site.site_id,
        rows.map((r) => ({
          kg_co2_per_kwh: Number(r.value),
          source: r.source.trim(),
          effective_from: r.effective_from,
        })),
      ),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["site-emission-factors", site.site_id] });
    },
    onError: (e) => {
      setSaved(false);
      setErr(apiError(e, "Could not save the emission factors"));
    },
  });

  const set = (i: number, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
    setSaved(false);
  };

  const errors = rows.map(rowError);
  const dupDates = new Set(
    rows.map((r) => r.effective_from).filter((d, i, a) => d && a.indexOf(d) !== i),
  );
  const firstError =
    errors.find(Boolean) ||
    (dupDates.size ? `Two factors share the same effective-from date (${[...dupDates].join(", ")})` : null);

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-nb-ink">Grid emission factor</h3>
        <p className="mt-0.5 text-xs text-nb-muted">
          kg CO₂ per kWh, <em>with its citation</em>. CO₂ figures multiply measured consumption by
          this number; without a row here they are simply absent — never estimated.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-xs text-nb-faint">Loading factors…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-3 text-[11.5px] text-nb-faint">
          No factor recorded, so no CO₂ figure is computed for this site. Nothing is pre-filled —
          a &ldquo;standard&rdquo; grid factor nobody cited would be an invented number.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div
              key={i}
              className="grid grid-cols-2 items-end gap-x-3 gap-y-2 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.4)] px-3 py-2.5 md:grid-cols-[.9fr_2fr_1fr_auto]"
            >
              <FInput label="kg CO₂ / kWh" mono inputMode="decimal" value={r.value} onChange={(v: any) => set(i, { value: v })} placeholder="0.716" />
              <FInput
                label="Source (required)"
                value={r.source}
                onChange={(v: any) => set(i, { source: v })}
                placeholder="e.g. CEA CO₂ Baseline Database v19 (2023), grid average"
                hint={i === 0 ? "Who published this number. A factor with no citation is refused." : undefined}
              />
              <FInput label="Effective from" type="date" value={r.effective_from} onChange={(v: any) => set(i, { effective_from: v })} />
              {editable && (
                <RowAction
                  icon="heroicons-outline:trash"
                  title="Remove factor"
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

      {editable && (
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton
            icon="heroicons-outline:plus"
            onClick={() => {
              setRows((prev) => [...prev, { value: "", source: "", effective_from: "" }]);
              setDirty(true);
              setSaved(false);
            }}
            className="!px-3 !py-1.5 !text-xs"
          >
            Add factor
          </ActionButton>
          <ActionButton onClick={() => save.mutate()} disabled={save.isPending || !!firstError || !dirty} className="!px-3 !py-1.5 !text-xs">
            {save.isPending ? "Saving…" : "Save factors"}
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
          You do not hold <span className="font-mono">sites.update</span>, so the factors are read-only here.
        </p>
      )}
    </section>
  );
}
