"use client";

// The WIDGET PALETTE — the seven chart types, discoverable.
//
// PORTED from the reference's `widget-palette.tsx` (41 lines) and lifted out of
// `DashboardView`, where it had been inlined. The extraction is the point of this
// change: the palette is now one component reading `WIDGET_TYPES`, so the catalog,
// the editor's chart picker and the palette cannot show three different sets.
//
// Beyond the port:
//
// * a SEARCH box, because "which of these shows a share of a total" is the
//   question somebody actually has, and `hint` already answers it — matching on
//   the hint as well as the label makes typing "share" find the pie chart and
//   typing "many series" find the heatmap;
// * each entry says its DEFAULT SIZE, so a person can see that a stat is small
//   and a heatmap is wide before they drop one;
// * both the click and the drag paths, as before — the drag is the canvas's
//   `onDropType` handler and is what makes placement deliberate rather than
//   "appended at the bottom".

import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { DEFAULT_SIZE } from "./constants";
// The drag payload key comes from the CANVAS, which reads it. Declaring a second
// copy here is how a drag silently does nothing.
import { WIDGET_DND_TYPE } from "./GridCanvas";
import { WIDGET_TYPES } from "./widget-types";

export default function WidgetPalette({ onAdd }: { onAdd: (type: string) => void }) {
  const [search, setSearch] = useState("");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return WIDGET_TYPES;
    return WIDGET_TYPES.filter(
      (w) => w.label.toLowerCase().includes(q) || w.hint.toLowerCase().includes(q),
    );
  }, [search]);

  return (
    <div className="hidden w-[196px] shrink-0 flex-col gap-1.5 overflow-y-auto rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] p-2.5 lg:flex">
      <span className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-[1.4px] text-nb-faint">
        Add a widget
      </span>
      <span className="px-1 pb-1 text-[10px] leading-snug text-nb-faint/80">
        Click, or drag onto the canvas.
      </span>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search charts…"
        aria-label="Search chart types"
        className="mb-0.5 w-full rounded-[7px] border border-nb-line bg-[rgba(6,11,26,.6)] px-2 py-1 text-[11.5px] text-nb-ink outline-none placeholder:text-nb-faint focus:border-nb-line2"
      />

      {shown.length === 0 ? (
        <p className="px-1 py-2 text-[10.5px] leading-snug text-nb-faint">
          Nothing matches “{search}”. This build draws {WIDGET_TYPES.length} chart
          types.
        </p>
      ) : null}

      {shown.map((w) => {
        const size = DEFAULT_SIZE[w.type];
        return (
          <button
            key={w.type}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(WIDGET_DND_TYPE, w.type);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAdd(w.type)}
            className="flex cursor-grab flex-col gap-0.5 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-2.5 py-2 text-left transition hover:border-nb-line2 active:cursor-grabbing"
          >
            <span className="flex items-center gap-1.5 text-[11.5px] text-nb-ink">
              <Icon icon={w.icon} className="shrink-0 text-[14px] text-nb-violetb" />
              {w.label}
              {size ? (
                <span className="ml-auto shrink-0 font-mono text-[9.5px] text-nb-faint">
                  {size.w}×{size.h}
                </span>
              ) : null}
            </span>
            <span className="text-[10px] leading-snug text-nb-faint">{w.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
