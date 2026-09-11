"use client";

// THE WEEK, PAINTED.
//
// Seven rows of twenty-four cells, and the operator drags across them. That is the
// whole interaction, and it is the right one: a schedule is a shape, and every
// alternative — start/end pickers, a rule builder — makes somebody describe a
// shape they can already see.
//
// THE DRAG DECIDES ITS VALUE FROM THE CELL IT STARTED ON, not from a mode. Clicking
// an off hour paints the current tool; starting a drag ON an hour that already
// holds that tool ERASES instead. So one gesture both draws and clears, and an
// operator correcting an overshoot does not have to go and find a rubber.
//
// The grid is a role="grid" of buttons rather than a canvas: every cell has to be
// reachable and announce what it is, and an hour of somebody's week is exactly the
// kind of thing that must not be mouse-only.
import { useCallback, useEffect, useRef, useState } from "react";

import { DAYS, type Slot, type Week } from "./weekSchedule";

export interface WeekPainterProps {
  week: Week;
  /** Absent = read-only, which is what a viewer gets. */
  onChange?: (next: Week) => void;
  /** What a fresh drag paints. */
  tool?: Slot;
}

const FILL: Record<Slot, string> = {
  record: "bg-nb-blue",
  motion: "bg-amber-500",
  off: "bg-[rgba(120,150,200,.10)]",
};

const LABEL: Record<Slot, string> = {
  record: "continuous",
  motion: "motion only",
  off: "off",
};

/** The value a drag writes: the tool, unless the cell it began on already held the
 *  tool — then the gesture is an erase. */
export function strokeValue(current: Slot, tool: Slot): Slot {
  return current === tool ? "off" : tool;
}

/** A rectangle between two cells, so a drag across rows fills the block an operator
 *  is clearly describing rather than a snake through the hours. */
export function cellsBetween(a: [number, number], b: [number, number]): [number, number][] {
  const [d0, d1] = a[0] <= b[0] ? [a[0], b[0]] : [b[0], a[0]];
  const [h0, h1] = a[1] <= b[1] ? [a[1], b[1]] : [b[1], a[1]];
  const out: [number, number][] = [];
  for (let d = d0; d <= d1; d++) for (let h = h0; h <= h1; h++) out.push([d, h]);
  return out;
}

/** Apply one stroke. Returns a new week; the caller owns the state. */
export function applyStroke(week: Week, cells: [number, number][], value: Slot): Week {
  const next = week.map((row) => row.slice());
  for (const [d, h] of cells) next[d][h] = value;
  return next;
}

export default function WeekPainter({ week, onChange, tool = "record" }: Readonly<WeekPainterProps>) {
  const readOnly = !onChange;
  const [anchor, setAnchor] = useState<[number, number] | null>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  // The value the live drag is writing, fixed at mousedown. Recomputing it per cell
  // would flip mid-drag the moment the pointer crossed an hour that already held
  // the tool, so a single sweep would paint and erase in stripes.
  const valueRef = useRef<Slot>("record");

  // A drag that ends outside the grid still has to end. Without this the grid stays
  // "pressed" and the next innocent hover paints a block.
  useEffect(() => {
    if (!anchor) return;
    const up = () => setAnchor(null);
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, [anchor]);

  const commit = useCallback(
    (to: [number, number]) => {
      if (!anchor || !onChange) return;
      onChange(applyStroke(week, cellsBetween(anchor, to), valueRef.current));
    },
    [anchor, onChange, week],
  );

  const begin = (d: number, h: number) => {
    if (readOnly) return;
    valueRef.current = strokeValue(week[d][h], tool);
    setAnchor([d, h]);
    onChange?.(applyStroke(week, [[d, h]], valueRef.current));
  };

  const preview = anchor && hover ? cellsBetween(anchor, hover) : [];
  const inPreview = (d: number, h: number) => preview.some(([pd, ph]) => pd === d && ph === h);

  return (
    <div className="select-none">
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: "34px repeat(24, minmax(0,1fr))" }} role="grid">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          // Every third hour only: 24 labels at this width overlap into a smear.
          <div key={h} className="pb-1 text-center font-mono text-[9px] text-nb-faint">
            {h % 3 ? "" : h}
          </div>
        ))}
        {DAYS.map((day, d) => (
          <div key={day} className="contents" role="row">
            <div className="flex h-[22px] items-center text-[10.5px] text-nb-faint">{day}</div>
            {week[d].map((slot, h) => (
              <button
                // day+hour, not the array index: the index happens to be stable
                // here because the row is always 24 long, and a key that is right
                // by coincidence is one that breaks when the shape changes.
                key={`${day}-${h}`}
                type="button"
                role="gridcell"
                disabled={readOnly}
                aria-label={`${day} ${String(h).padStart(2, "0")}:00 — ${LABEL[slot]}`}
                onPointerDown={() => begin(d, h)}
                onPointerEnter={() => {
                  setHover([d, h]);
                  if (anchor) commit([d, h]);
                }}
                onPointerUp={() => setAnchor(null)}
                className={`h-[22px] rounded-[3px] transition-colors ${FILL[slot]} ${
                  readOnly ? "" : "cursor-pointer hover:brightness-125"
                } ${inPreview(d, h) ? "ring-1 ring-nb-cyan/60" : ""}`}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
