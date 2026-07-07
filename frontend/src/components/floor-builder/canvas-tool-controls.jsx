"use client";

// Floating tool + zoom controls shown over the canvas while drawing zones.
// Ported from neubit_v2, rethemed to neubit_v3 tokens.
import { Icon } from "@iconify/react";

import { TOOL_TYPES } from "@/components/floor-builder/constants";

const TOOLS = [
  { type: TOOL_TYPES.SELECT, icon: "heroicons-outline:cursor-arrow-rays", short: "Pick", label: "Select" },
  { type: TOOL_TYPES.ZONE_POLYGON, icon: "heroicons-outline:sparkles", short: "Poly", label: "Polygon Zone" },
];

export function CanvasToolControls({ activeTool, onToolSelect, canvasScale = 1, onScaleChange }) {
  const zoomIn = () => onScaleChange?.(Math.min(canvasScale * 1.2, 5));
  const zoomOut = () => onScaleChange?.(Math.max(canvasScale / 1.2, 0.1));
  const reset = () => onScaleChange?.(1);

  return (
    <div className="pointer-events-none absolute right-4 top-1/2 z-20 flex -translate-y-1/2 flex-col gap-3">
      <div className="pointer-events-auto w-20 rounded-3xl border border-card-border bg-card/95 p-3 shadow-2xl backdrop-blur">
        <div className="mb-3 text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">
          Tools
        </div>
        <div className="flex flex-col gap-2">
          {TOOLS.map((t) => {
            const active = activeTool === t.type;
            return (
              <button
                key={t.type}
                type="button"
                onClick={() => onToolSelect?.(t.type)}
                title={t.label}
                className={`flex flex-col items-center gap-1 rounded-2xl border px-2 py-2 text-[11px] font-medium transition-all ${
                  active
                    ? "border-transparent bg-foreground text-background shadow"
                    : "border-transparent text-muted hover:bg-hover"
                }`}
              >
                <Icon icon={t.icon} className="text-xl" />
                <span>{t.short}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pointer-events-auto w-20 rounded-3xl border border-card-border bg-card/95 p-3 text-center shadow-2xl backdrop-blur">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-muted">Zoom</div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={zoomIn}
            disabled={canvasScale >= 5}
            title="Zoom in"
            className="flex items-center justify-center rounded-2xl border border-card-border bg-hover py-2 text-foreground transition hover:bg-hover/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:plus" className="text-xl" />
          </button>
          <button
            type="button"
            onClick={reset}
            title="Reset zoom"
            className="flex items-center justify-center rounded-2xl border border-card-border bg-card py-2 text-xs font-semibold text-muted transition hover:bg-hover"
          >
            {Math.round(canvasScale * 100)}%
          </button>
          <button
            type="button"
            onClick={zoomOut}
            disabled={canvasScale <= 0.1}
            title="Zoom out"
            className="flex items-center justify-center rounded-2xl border border-card-border bg-hover py-2 text-foreground transition hover:bg-hover/70 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon="heroicons-outline:minus" className="text-xl" />
          </button>
        </div>
      </div>
    </div>
  );
}
