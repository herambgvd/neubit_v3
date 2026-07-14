"use client";

// LayoutPicker — icon-based layout presets for the video wall. Replaces the old
// stack of text buttons with a compact popover of MINI-GRID glyphs (each glyph
// literally draws the layout it selects), so operators recognise 3×3 vs a 1+5
// spotlight at a glance. The active layout shows inline on the wall toolbar.
//
// Pure presentational SVG — no external icon set needed for the glyphs, which
// keeps them crisp at 18px and lets us draw the asymmetric spotlight shapes.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { LAYOUTS, getLayout } from "../videoWall";

// Draw a layout as a tiny grid of rounded rects inside a 24×24 viewBox.
function LayoutGlyph({ layout, className = "" }) {
  const pad = 2;
  const size = 24 - pad * 2;

  let rects = [];
  if (Array.isArray(layout.template)) {
    // Spotlight: parse the area template into bounding boxes per tile token.
    const rows = layout.template.map((r) => r.trim().split(/\s+/));
    const cols = rows[0].length;
    const rowCount = rows.length;
    const cw = size / cols;
    const ch = size / rowCount;
    const boxes = new Map();
    rows.forEach((cells, r) => {
      cells.forEach((tok, c) => {
        const b = boxes.get(tok) || { minC: c, maxC: c, minR: r, maxR: r };
        b.minC = Math.min(b.minC, c);
        b.maxC = Math.max(b.maxC, c);
        b.minR = Math.min(b.minR, r);
        b.maxR = Math.max(b.maxR, r);
        boxes.set(tok, b);
      });
    });
    rects = [...boxes.values()].map((b) => ({
      x: pad + b.minC * cw,
      y: pad + b.minR * ch,
      w: (b.maxC - b.minC + 1) * cw,
      h: (b.maxR - b.minR + 1) * ch,
    }));
  } else {
    const cw = size / layout.cols;
    const ch = size / layout.rows;
    for (let r = 0; r < layout.rows; r += 1) {
      for (let c = 0; c < layout.cols; c += 1) {
        rects.push({ x: pad + c * cw, y: pad + r * ch, w: cw, h: ch });
      }
    }
  }

  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      {rects.map((rc, i) => (
        <rect
          key={i}
          x={rc.x + 0.6}
          y={rc.y + 0.6}
          width={Math.max(0, rc.w - 1.2)}
          height={Math.max(0, rc.h - 1.2)}
          rx={1}
          fill="currentColor"
          fillOpacity={i === 0 && Array.isArray(layout.template) ? 0.9 : 0.55}
        />
      ))}
    </svg>
  );
}

export default function LayoutPicker({ layoutKey, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = getLayout(layoutKey);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Change layout"
        className="inline-flex h-8 items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 text-xs font-medium text-foreground transition hover:bg-hover"
      >
        <LayoutGlyph layout={active} className="h-4 w-4 text-blue-500" />
        <span className="tabular-nums">{active.label}</span>
        <Icon icon="heroicons-mini:chevron-down" className="text-sm text-muted" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-[13.5rem] rounded-xl border border-card-border bg-card p-2 shadow-2xl">
          <p className="px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Grid layout
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {LAYOUTS.map((l) => {
              const on = l.key === layoutKey;
              return (
                <button
                  key={l.key}
                  type="button"
                  title={`${l.label} · ${l.capacity} tiles`}
                  onClick={() => {
                    onChange?.(l.key);
                    setOpen(false);
                  }}
                  className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border transition ${
                    on
                      ? "border-blue-500 bg-blue-500/10 text-blue-500"
                      : "border-card-border text-muted hover:border-muted hover:bg-hover hover:text-foreground"
                  }`}
                >
                  <LayoutGlyph layout={l} className="h-5 w-5" />
                  <span className="text-[9px] font-semibold leading-none">{l.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export { LayoutGlyph };
