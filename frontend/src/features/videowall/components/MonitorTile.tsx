"use client";

// One MONITOR on the operator console — a titled panel whose body is the
// monitor's own cell grid (1/4/9/16). Each cell is a WallCell (live camera or
// a drop target). A decoder monitor shows a "decoder" badge; its cells still
// render the live MediaMTX preview so the operator sees what's being pushed to
// the hardware output (the actual hardware push is VW-B, backend-side).
import { Icon } from "@iconify/react";

import WallCell from "./WallCell";
import { monitorGrid, monitorGridStyle, cameraAt } from "../wallLayout";

export default function MonitorTile({
  monitor,
  state,
  cameraById,
  control = false,
  onAssign, // (cellIndex, cameraId)
  onClearCell, // (cellIndex)
  onClearMonitor, // ()
  onPickCell, // (cellIndex)
}: any) {
  const { capacity } = monitorGrid(monitor.layout);
  const monState = state?.[monitor.id] || {};
  const filled = Object.values<any>(monState).filter(Boolean).length;
  const isDecoder = monitor.kind === "decoder";
  // Solo cell → main profile; dense → sub (bandwidth), same heuristic as /streaming.
  const profile = capacity <= 1 ? "main" : "sub";

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[8px] border border-[rgba(160,150,245,.22)] bg-[#05080f]">
      {/* Monitor header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[rgba(160,150,245,.18)] bg-[rgba(10,18,40,.65)] px-2 py-1">
        <Icon
          icon={isDecoder ? "heroicons:cpu-chip" : "heroicons:computer-desktop"}
          className={`text-xs ${isDecoder ? "text-[#fbbf24]" : "text-[#67e8f9]"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[#f2f6ff]">
          {monitor.name}
        </span>
        {isDecoder && (
          <span className="rounded-sm border border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.12)] px-1 font-mono text-[8px] font-semibold uppercase tracking-[.8px] text-[#fbbf24]">
            Decoder
          </span>
        )}
        <span className="font-mono text-[9px] tabular-nums text-[#9a92c8]">
          {filled}/{capacity}
        </span>
        {control && filled > 0 && (
          <button
            type="button"
            title="Clear monitor"
            onClick={onClearMonitor}
            className="rounded-sm p-0.5 text-[#9a92c8] transition hover:bg-[rgba(248,113,113,.15)] hover:text-[#f87171]"
          >
            <Icon icon="heroicons-outline:x-circle" className="text-[11px]" />
          </button>
        )}
      </div>

      {/* Monitor body — the cell grid */}
      <div className="min-h-0 flex-1 p-1">
        <div className="grid h-full min-h-0 gap-1" style={monitorGridStyle(monitor.layout)}>
          {Array.from({ length: capacity }, (_, cellIndex) => {
            const camId = cameraAt(state, monitor.id, cellIndex);
            return (
              <WallCell
                key={`${monitor.id}-${cellIndex}`}
                cellIndex={cellIndex}
                cameraId={camId}
                camera={camId ? cameraById?.get(camId) : null}
                profile={profile}
                control={control}
                onAssign={(cameraId) => onAssign?.(cellIndex, cameraId)}
                onClear={() => onClearCell?.(cellIndex)}
                onPick={() => onPickCell?.(cellIndex)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
