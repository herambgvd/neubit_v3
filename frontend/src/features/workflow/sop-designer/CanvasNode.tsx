"use client";

// A draggable SOP state node card — color accent bar, name, initial/terminal/
// cancellation badges, and a right-edge connect handle. World-space positioned
// (the parent's transform maps it to screen). All interactions are delegated up
// via the pointer handlers.
import { Icon } from "@iconify/react";
import { NODE_W, NODE_H, DEFAULT_COLOR } from "./lib/canvasGeometry";

export default function CanvasNode({ state, selected, onPointerDown, onPointerUp, onHandleDown, onEdit }: any) {
  const color = state.color || DEFAULT_COLOR;
  const badges: any[] = [];
  if (state.is_initial) badges.push(["Initial", "heroicons-solid:play", "#10b981"]);
  if (state.is_terminal) badges.push(["Terminal", "heroicons-solid:stop", "#64748b"]);
  if (state.is_cancellation) badges.push(["Cancel", "heroicons-solid:x-circle", "#ef4444"]);

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); onEdit(); }}
      className="absolute rounded-xl border bg-[rgba(8,15,34,.5)]  transition-shadow"
      style={{
        left: state.position_x ?? 0,
        top: state.position_y ?? 0,
        width: NODE_W,
        minHeight: NODE_H,
        cursor: "grab",
        borderColor: selected ? color : "var(--card-border)",
        boxShadow: selected ? `0 0 0 2px ${color}55, 0 6px 18px rgba(0,0,0,0.14)` : "0 2px 8px rgba(0,0,0,0.08)",
      }}
    >
      {/* color accent bar */}
      <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-xl" style={{ backgroundColor: color }} />
      <div className="pl-4 pr-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-1 h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
          <span className="text-sm font-semibold text-nb-ink leading-snug break-words">{state.name || "Untitled"}</span>
        </div>
        {badges.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {badges.map(([label, icon, c]) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${c}1a`, color: c }}
              >
                <Icon icon={icon} className="text-[11px]" /> {label}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* connect handle (right edge) */}
      <button
        type="button"
        title="Drag to connect"
        onPointerDown={onHandleDown}
        className="absolute -right-2.5 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full border-2 border-nb-line bg-[rgba(8,15,34,.5)] text-nb-muted hover:text-nb-ink flex items-center justify-center shadow-sm"
        style={{ cursor: "crosshair", color }}
      >
        <Icon icon="heroicons-solid:plus" className="text-[11px]" />
      </button>
    </div>
  );
}
