"use client";

// Hourly ingest volume, stacked by category — read from the `readings_1h`
// continuous aggregate (`GET /bi/activity`).
//
// It counts SAMPLES, which is a number the pipeline genuinely knows. It is not
// kWh, not litres, not degrees: nothing on the wire says what a point measures
// (contract §11/§12), so a physical quantity here would be invented. What this
// chart honestly answers is "is the building still talking, and which parts".
//
// The newest bar is the CURRENT, partial hour. `readings_1h` is a real-time
// aggregate so that bar is current rather than stale — but it is also incomplete
// by definition, which is why it is drawn at reduced opacity and labelled.
import { useMemo } from "react";

import { categoryMeta } from "../constants";

export interface ActivityRow {
  bucket: string;
  category: string | null;
  samples: number;
  points: number;
}

export default function ActivityChart({ rows = [] }: { rows: ActivityRow[] }) {
  const model = useMemo(() => {
    if (!rows.length) return null;
    const buckets = new Map<string, Map<string, number>>();
    const cats = new Set<string>();
    for (const r of rows) {
      const key = r.bucket;
      const cat = r.category ?? "";
      cats.add(cat);
      const m = buckets.get(key) || new Map<string, number>();
      m.set(cat, (m.get(cat) || 0) + r.samples);
      buckets.set(key, m);
    }
    const order = [...buckets.keys()].sort();
    const cols = order.map((b) => {
      const m = buckets.get(b)!;
      const total = [...m.values()].reduce((a, x) => a + x, 0);
      return { bucket: b, parts: m, total };
    });
    const max = Math.max(...cols.map((c) => c.total), 1);
    return { cols, max, cats: [...cats].sort() };
  }, [rows]);

  if (!model) {
    return (
      <div className="flex h-[150px] items-center justify-center text-[11.5px] text-nb-faint">
        No ingest in this window
      </div>
    );
  }

  const lastIndex = model.cols.length - 1;

  return (
    <div>
      {/* Bars are capped in width and left-aligned. The store can hold anywhere
          from two hours to twenty-four, and a flex-1 column over three buckets
          would stretch into slabs that read as a much bigger dataset than there
          is. Capping keeps a short history looking short. */}
      <div className="flex h-[150px] items-end gap-[3px]">
        {model.cols.map((c, i) => (
          <div
            key={c.bucket}
            className="group relative flex min-w-0 flex-1 flex-col justify-end"
            style={{ height: "100%", maxWidth: 44 }}
            title={`${new Date(c.bucket).toLocaleString()} — ${c.total.toLocaleString()} samples${
              i === lastIndex ? " (current hour, still filling)" : ""
            }`}
          >
            {model.cats.map((cat) => {
              const v = c.parts.get(cat) || 0;
              if (!v) return null;
              return (
                <div
                  key={cat}
                  style={{
                    height: `${(v / model.max) * 100}%`,
                    background: categoryMeta(cat || null).accent,
                    opacity: i === lastIndex ? 0.45 : 0.85,
                  }}
                  className="w-full first:rounded-t-[3px]"
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center justify-between font-mono text-[9.5px] text-nb-faint">
        <span>{new Date(model.cols[0].bucket).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" })}</span>
        <span>current hour is partial</span>
        <span>{new Date(model.cols[lastIndex].bucket).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {model.cats.map((cat) => {
          const meta = categoryMeta(cat || null);
          return (
            <span key={cat} className="flex items-center gap-1.5 text-[11px] text-nb-soft">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: meta.accent }} />
              {meta.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
