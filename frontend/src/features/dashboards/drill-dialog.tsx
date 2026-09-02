"use client";

// The drill-down dialog. PORTED in shape from the reference's `drill-dialog.tsx`
// (145 lines): a modal naming the clicked field and value, a bounded table of
// detail rows, and a note when there are more than it shows.
//
// The data path is different in a way that made this file SHORTER than the one it
// came from. Theirs has to run a second, separately-authored SQL query, and has a
// fallback that filters the rows already on screen when that query fails — two
// paths, one of which quietly presents aggregate rows as detail. Ours derives new
// builder STATE (`drill.ts`) and renders `<WidgetBody>`, which is the same
// component the canvas uses. So the detail gets the same loading states, the same
// error text, and — the thing the fallback path loses — its own
// `resolution_reason`, because it genuinely went through the executor.
//
// The one thing added: a "break down by" picker. Having pinned one value, the
// next question is always "by what", and since the drill is a pure function from
// state to state, changing it is one more derivation rather than another query
// somebody has to have written in advance.

import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Modal, Select } from "@/components/ui/kit";

import { WidgetBody } from "./ChartWidget";
import type { QueryContext } from "./dashboard-context";
import { DRILL_LIMIT, defaultBreakdown, deriveDrillSpec, dimensionLabel } from "./drill";
import type { Dataset, WidgetSpec } from "./spec";

export interface DrillState {
  /** The widget that was clicked. */
  spec: WidgetSpec;
  title: string;
  /** The dimension the clicked point identifies, and the value it carried. */
  dimension: string;
  value: string;
}

export default function DrillDialog({
  drill,
  dataset,
  context,
  onClose,
}: {
  drill: DrillState | null;
  dataset?: Dataset;
  context?: QueryContext | null;
  onClose: () => void;
}) {
  const [breakdown, setBreakdown] = useState<string | null>(null);

  // The default is recomputed per drill rather than held in state, so opening a
  // second drill from a different chart does not inherit the first one's choice.
  const fallback = useMemo(
    () => (drill ? defaultBreakdown(drill.spec, dataset, drill.dimension) : null),
    [drill, dataset],
  );
  const chosen = breakdown ?? fallback;

  const derived = useMemo(
    () => (drill ? deriveDrillSpec(drill.spec, dataset, drill.dimension, drill.value, chosen) : null),
    [drill, dataset, drill?.dimension, drill?.value, chosen],
  );

  const options = (dataset?.dimensions || [])
    .filter((d) => d.key !== drill?.dimension)
    .map((d) => ({ value: d.key, label: d.label }));

  return (
    <Modal
      open={!!drill}
      onClose={() => {
        setBreakdown(null);
        onClose();
      }}
      size="lg"
      title="Behind this point"
      subtitle="Derived from this widget's own query — the same executor, the same window, the same rules."
      footer={
        <Button
          variant="ghost"
          onClick={() => {
            setBreakdown(null);
            onClose();
          }}
        >
          Close
        </Button>
      }
    >
      {!drill || !derived ? null : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.45)] px-3 py-2">
            <Icon icon="heroicons:funnel" className="shrink-0 text-[14px] text-nb-blueb" />
            <span className="text-[11px] uppercase tracking-[1.2px] text-nb-faint">
              {dimensionLabel(dataset, drill.dimension)}
            </span>
            <span className="max-w-[280px] truncate rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-2.5 py-0.5 text-[11.5px] text-nb-blueb">
              {drill.value}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="text-[11px] text-nb-faint">Break down by</span>
              <div className="w-[170px]">
                <Select
                  value={chosen || ""}
                  onChange={(e: any) => setBreakdown(e.target.value || null)}
                  options={[{ value: "", label: "Nothing — one row" }, ...options]}
                />
              </div>
            </span>
          </div>

          <div className="h-[320px] overflow-hidden rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.55)]">
            <WidgetBody spec={derived} refreshMs={0} context={context} />
          </div>

          <p className="text-[10.5px] leading-snug text-nb-faint">
            At most {DRILL_LIMIT} rows — a drill is a look, not an export. The
            value shown was BOUND as a query parameter, so a series whose name
            looks like a fragment of SQL is compared against a column like any
            other string.
          </p>
        </div>
      )}
    </Modal>
  );
}
