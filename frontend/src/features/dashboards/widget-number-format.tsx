"use client";

// The "Number format" section of the widget editor.
//
// PORTED from the reference's `widget-number-format.tsx` (141 lines): prefix,
// suffix, fixed decimals, thousands grouping, compact notation, and a live
// preview of a sample number. That set is right and it is kept.
//
// ONE FIELD ADDED, AND IT IS THE POINT OF THIS SECTION HERE
// ---------------------------------------------------------
// A UNIT, separate from `suffix`, and labelled as an assertion.
//
// Contract §4 says the software must never invent a unit, and on this platform
// it genuinely cannot: `points.unit` is NULL for every IoT point because nothing
// on the wire carries one. So every axis in this module is blank, forever, unless
// somebody who knows what the meter measures says so.
//
// This is that somebody. The field is theirs to fill in, the copy says plainly
// that filling it in is a claim rather than a reading, and the widget carries the
// attribution onto its own footer (`unitNote`). What is NOT offered anywhere is a
// way for the console to guess one.
//
// `suffix` stays as the reference has it, for the things that are decoration
// rather than a claim — "%", "×". Keeping the two apart is what makes the
// attribution meaningful.

import { Icon } from "@iconify/react";

import { Input, Select } from "@/components/ui/kit";

import { MAX_UNIT, formatNumber, tidyFormat } from "./number-format";
import type { NumberFormat } from "./number-format";

export default function WidgetNumberFormat({
  options,
  onChange,
}: {
  options: Record<string, any>;
  onChange: (next: Record<string, any>) => void;
}) {
  const format: NumberFormat = options?.format || {};

  const set = (patch: Partial<NumberFormat>) => {
    const next = tidyFormat({ ...format, ...patch });
    const opts = { ...(options || {}) };
    if (Object.keys(next).length === 0) delete opts.format;
    else opts.format = next;
    // The older, narrower `options.decimals` is dropped once this section is
    // used: two places spelling the same number is how a tooltip and an axis end
    // up disagreeing.
    if ("decimals" in opts) delete opts.decimals;
    onChange(opts);
  };

  const sample = format.compact ? 1234567.891 : 1234.5678;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="Prefix"
          placeholder="e.g. $"
          value={format.prefix || ""}
          onChange={(e: any) => set({ prefix: e.target.value })}
        />
        <Input
          label="Suffix"
          hint="decoration, not a unit"
          placeholder="e.g. %"
          value={format.suffix || ""}
          onChange={(e: any) => set({ suffix: e.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Select
          label="Decimals"
          value={format.decimals === undefined ? "" : String(format.decimals)}
          onChange={(e: any) =>
            set({ decimals: e.target.value === "" ? undefined : Number(e.target.value) })
          }
          options={[
            { value: "", label: "Automatic" },
            ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) })),
          ]}
        />
        <div className="space-y-1.5 pt-[18px]">
          <label className="flex items-center gap-1.5 text-[11.5px] text-nb-soft">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-nb-blue"
              checked={format.thousands !== false}
              onChange={(e) => set({ thousands: e.target.checked ? undefined : false })}
            />
            Thousands separator
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-nb-soft">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-nb-blue"
              checked={!!format.compact}
              onChange={(e) => set({ compact: e.target.checked || undefined })}
            />
            Abbreviate large numbers (1.2K)
          </label>
        </div>
      </div>

      {/* ── the unit, and what stating one means ─────────────────────────── */}
      <div className="rounded-[10px] border border-[rgba(251,191,36,.28)] bg-[rgba(251,191,36,.06)] p-2.5">
        <Input
          label="Unit"
          hint={`optional · at most ${MAX_UNIT} characters`}
          placeholder="e.g. kW, A, °C"
          maxLength={MAX_UNIT}
          value={format.unit || ""}
          onChange={(e: any) => set({ unit: e.target.value })}
        />
        <p className="mt-1.5 flex gap-1.5 text-[10.5px] leading-snug text-nb-warn">
          <Icon icon="heroicons:exclamation-triangle" className="mt-[1px] shrink-0 text-[12px]" />
          <span>
            This dataset carries no unit — nothing in the incoming data says what
            these numbers measure, and this console will never guess one. A unit
            typed here is <strong>your assertion</strong>, not something read from
            the data, and the widget says so wherever it shows it. Leave it blank
            if you are not certain.
          </span>
        </p>
      </div>

      <div className="flex items-baseline gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2.5 py-1.5">
        <span className="text-[10px] uppercase tracking-[1.2px] text-nb-faint">Preview</span>
        <span className="font-mono text-[12.5px] tabular-nums text-nb-ink">
          {formatNumber(sample, format)}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-nb-faint">
          {/* Absence, shown alongside — so an author can see that a bucket with
              no reading stays an em dash and does NOT acquire their unit. */}
          no reading → {formatNumber(null, format)}
        </span>
      </div>
    </div>
  );
}
