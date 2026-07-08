"use client";

// "Preview against sample payload" box for the trigger conditions editor. Paste
// a JSON payload, evaluate the current AND-list of conditions client-side (no
// API), and show per-condition ✓/✗ + the overall match. Uses lib/matcher.js.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { evaluateConditions, coerceValue, stringifyValue, OP_LABEL } from "../../lib/matcher";

const SAMPLE = JSON.stringify(
  { device_id: "cam-42", device: { zone_type: "secure" }, priority: 4 },
  null,
  2,
);

export default function ConditionsPreview({ conditions }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(SAMPLE);

  // Wire-shape the conditions (coerce typed values) once per change.
  const wire = useMemo(
    () =>
      (conditions || [])
        .filter((c) => (c.path || "").trim())
        .map((c) => ({ path: c.path, op: c.op, value: coerceValue(c.op, c.value) })),
    [conditions],
  );

  const parsed = useMemo(() => {
    if (!text.trim()) return { env: {}, err: null };
    try {
      return { env: JSON.parse(text), err: null };
    } catch (e) {
      return { env: null, err: e.message || "Invalid JSON" };
    }
  }, [text]);

  const result = useMemo(
    () => (parsed.env ? evaluateConditions(parsed.env, wire) : null),
    [parsed.env, wire],
  );

  return (
    <div className="rounded-lg border border-card-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted hover:text-foreground"
      >
        <span className="inline-flex items-center gap-1.5">
          <Icon icon="heroicons-outline:beaker" className="text-sm" /> Preview against sample payload
        </span>
        <Icon icon={open ? "heroicons-outline:chevron-up" : "heroicons-outline:chevron-down"} className="text-sm" />
      </button>
      {open && (
        <div className="grid grid-cols-1 gap-3 border-t border-card-border p-3 md:grid-cols-2">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted">Sample payload (JSON)</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="mt-1 h-44 w-full rounded-lg border border-field bg-transparent px-2.5 py-2 text-xs font-mono text-foreground outline-none focus:border-muted"
            />
            {parsed.err && <p className="mt-1 text-[11px] text-red-500">JSON error: {parsed.err}</p>}
          </div>
          <div className="min-w-0">
            <label className="text-[11px] font-medium uppercase tracking-wide text-muted">Result</label>
            {!result ? (
              <p className="mt-2 text-[11px] text-muted/70">Fix the JSON to preview.</p>
            ) : (
              <div className="mt-1 space-y-2">
                <div className={`rounded-md border px-2.5 py-1.5 text-xs font-medium ${result.allMatch ? "border-green-500/40 bg-green-500/10 text-green-500" : "border-red-500/40 bg-red-500/10 text-red-500"}`}>
                  {result.allMatch ? "Matched — all conditions pass." : "No match — a condition failed."}
                </div>
                {result.rows.length === 0 ? (
                  <p className="text-[11px] text-muted/70">No conditions — fires on every matching event type.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {result.rows.map((r, i) => (
                      <li key={i} className="flex items-start gap-2 rounded-md border border-card-border bg-hover/40 px-2 py-1.5">
                        <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${r.matched ? "bg-green-500/15 text-green-500" : "bg-red-500/15 text-red-500"}`}>
                          <Icon icon={r.matched ? "heroicons-outline:check" : "heroicons-outline:x-mark"} className="text-[10px]" />
                        </span>
                        <span className="min-w-0 text-[11px]">
                          <span className="block truncate font-mono text-foreground">
                            {r.condition.path} {OP_LABEL[r.condition.op] || r.condition.op} {stringifyValue(r.condition.op, r.condition.value)}
                          </span>
                          <span className="mt-0.5 block truncate text-[10px] text-muted">
                            actual: <span className="font-mono">{r.actual === undefined ? "undefined" : JSON.stringify(r.actual)}</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
