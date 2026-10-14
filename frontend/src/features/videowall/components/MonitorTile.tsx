"use client";

// One MONITOR on the operator console — a titled panel whose body is the
// monitor's own cell grid (1/4/9/16). Each cell is a WallCell (live camera or
// a drop target). A decoder monitor shows a "decoder" badge; its cells still
// render the live MediaMTX preview so the operator sees what's being pushed to
// the hardware output (the actual hardware push is VW-B, backend-side).
import { Icon } from "@iconify/react";

import type { EstateCamera } from "@/features/vms/types";

import WallCell from "./WallCell";
import { monitorGrid, monitorGridStyle, cameraAt, type WallMonitor } from "../wallLayout";
import type { WallState } from "../types";

export interface MonitorTileProps {
  monitor: WallMonitor;
  state?: WallState | null;
  /** Estate cameras keyed by id, for the per-cell name strip. */
  cameraById?: Map<string, EstateCamera>;
  control?: boolean;
  onAssign?: (cellIndex: number, cameraId: string) => void;
  onClearCell?: (cellIndex: number) => void;
  onClearMonitor?: () => void;
  onPickCell?: (cellIndex: number) => void;
}

export default function MonitorTile({
  monitor,
  state,
  cameraById,
  control = false,
  onAssign,
  onClearCell,
  onClearMonitor,
  onPickCell,
}: Readonly<MonitorTileProps>) {
  const { capacity } = monitorGrid(monitor.layout);
  const monState = state?.[monitor.id] || {};
  const filled = Object.values(monState).filter(Boolean).length;
  const isDecoder = monitor.kind === "decoder";
  // Solo cell → main profile; dense → sub (bandwidth), same heuristic as /streaming.
  const profile = capacity <= 1 ? "main" : "sub";

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[8px] border border-nb-haze/22 bg-[#05080f]">
      {/* Monitor header */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-nb-haze/18 bg-nb-surface/65 px-2 py-1">
        <Icon
          icon={isDecoder ? "heroicons:cpu-chip" : "heroicons:computer-desktop"}
          className={`text-xs ${isDecoder ? "text-nb-warn" : "text-nb-tealb"}`}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-nb-ink">
          {monitor.name}
        </span>
        {isDecoder && (
          <span className="rounded-sm border border-nb-warn/45 bg-nb-warn/12 px-1 font-mono text-[8px] font-semibold uppercase tracking-[.8px] text-nb-warn">
            Decoder
          </span>
        )}
        <span className="font-mono text-[9px] tabular-nums text-nb-faint">
          {filled}/{capacity}
        </span>
        {control && filled > 0 && (
          <button
            type="button"
            title="Clear monitor"
            onClick={onClearMonitor}
            className="rounded-sm p-0.5 text-nb-faint transition hover:bg-nb-crit/15 hover:text-nb-crit"
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
                onAssign={(cameraId: string) => onAssign?.(cellIndex, cameraId)}
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
