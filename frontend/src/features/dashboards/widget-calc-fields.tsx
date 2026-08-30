"use client";

// The "Calculated fields" section of the widget editor.
//
// The reference has no dedicated component for this — the formula box lives
// inline in its widget config — but `calc-fields.ts` is theirs and this is its
// surface. Two things it does that the inline version cannot:
//
// * it validates against the columns THIS widget's preview actually returned, so
//   a typo is named while you type rather than discovered as a column that
//   silently never appears;
// * it offers the available columns as click-to-insert chips, wrapped in
//   `[brackets]`, because the executor names a column after a measure's LABEL
//   ("Reading value") and a bare identifier cannot express a space.
//
// The honesty line at the bottom is not decoration. A calculated field is
// arithmetic over rows that have already been aggregated by the server, and that
// is a real limitation: `avg(a) / avg(b)` is not `avg(a/b)`. Saying so is
// cheaper than the argument that starts when somebody notices.

import { useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Input } from "@/components/ui/kit";

import { MAX_CALC_FIELDS, validateFormula } from "./calc-fields";
import type { CalcField } from "./calc-fields";

export default function WidgetCalcFields({
  options,
  columns,
  onChange,
}: {
  options: Record<string, any>;
  /** The columns the preview's last result carried. Empty until it has run. */
  columns: string[];
  onChange: (next: Record<string, any>) => void;
}) {
  const fields: CalcField[] = options?.calc_fields || [];
  const [focused, setFocused] = useState<number | null>(null);

  const write = (next: CalcField[]) => {
    const opts = { ...(options || {}) };
    if (next.length === 0) delete opts.calc_fields;
    else opts.calc_fields = next;
    onChange(opts);
  };

  const patch = (i: number, p: Partial<CalcField>) =>
    write(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));

  return (
    <div className="space-y-2">
      {fields.length === 0 ? (
        <p className="text-[11px] leading-snug text-nb-faint">
          A column worked out from the ones this widget already returned — a
          difference, a ratio, a scaled value. It runs in the browser over the
          result; it never changes the query.
        </p>
      ) : null}

      {fields.map((f, i) => {
        const issue = f.formula.trim() && columns.length ? validateFormula(f.formula, columns) : null;
        return (
          <div key={i} className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] p-2">
            <div className="flex items-start gap-1.5">
              <div className="grid min-w-0 flex-1 gap-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
                <Input
                  label="Column name"
                  placeholder="e.g. Difference"
                  value={f.name}
                  onChange={(e: any) => patch(i, { name: e.target.value })}
                />
                <Input
                  label="Formula"
                  placeholder="[A] - [B]"
                  value={f.formula}
                  onFocus={() => setFocused(i)}
                  onChange={(e: any) => patch(i, { formula: e.target.value })}
                />
              </div>
              <button
                type="button"
                aria-label="Remove calculated field"
                onClick={() => write(fields.filter((_, j) => j !== i))}
                className="mt-[18px] shrink-0 rounded-[6px] p-1 text-nb-faint transition-colors hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
              >
                <Icon icon="heroicons:x-mark" className="text-[13px]" />
              </button>
            </div>

            {focused === i && columns.length ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1">
                <span className="text-[9.5px] uppercase tracking-[1.1px] text-nb-faint">Columns</span>
                {columns.map((c) => (
                  <button
                    key={c}
                    type="button"
                    // `onMouseDown` + preventDefault, not onClick: a click would
                    // blur the formula box first and close this row.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      patch(i, { formula: `${f.formula}${f.formula ? " " : ""}[${c}]` });
                    }}
                    className="max-w-[140px] truncate rounded-[6px] border border-nb-line bg-[rgba(8,15,34,.6)] px-1.5 py-0.5 font-mono text-[10px] text-nb-blueb transition hover:border-nb-line2"
                  >
                    [{c}]
                  </button>
                ))}
              </div>
            ) : null}

            {issue ? <p className="mt-1 text-[10.5px] leading-snug text-nb-crit">{issue}</p> : null}
          </div>
        );
      })}

      {fields.length < MAX_CALC_FIELDS ? (
        <Button
          variant="ghost"
          icon="heroicons:plus"
          onClick={() => write([...fields, { name: "", formula: "" }])}
        >
          Add calculated field
        </Button>
      ) : null}

      {fields.length ? (
        <p className="flex gap-1.5 text-[10.5px] leading-snug text-nb-faint">
          <Icon icon="heroicons:information-circle" className="mt-[1px] shrink-0 text-[12px]" />
          <span>
            Arithmetic over rows the server has already aggregated — so an average
            divided by an average is not the average of the division. A row where
            any operand has no reading stays empty rather than counting as zero,
            and dividing by zero gives no value rather than infinity.
          </span>
        </p>
      ) : null}
    </div>
  );
}
