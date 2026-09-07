"use client";

// One CELL inside a monitor on the video wall. A cell holds a single camera and,
// when filled, renders the SAME LivePlayer used by the /streaming wall — so a
// wall cell showing a camera plays exactly like a streaming tile (WHEP-first,
// HLS fallback, session lifecycle managed by useLiveSession).
//
// Two modes:
//   • control (operator console): drop target for a camera dragged off the rail
//     → push(monitor, cell, camera); hover toolbar to clear the cell.
//   • read-only (kiosk): renders the assigned camera live, no chrome, no drops.
//
// Empty cell is near-black with a faint glyph — matches the Streaming WallTile
// aesthetic so a sparse wall reads clean, not as a field of dashed drop boxes.
import { useState, type DragEvent } from "react";
import { Icon } from "@iconify/react";

import LivePlayer from "@/features/vms/components/LivePlayer";
import type { EstateCamera } from "@/features/vms/types";

export interface WallCellProps {
  /** The camera assigned to this cell, or null/undefined when it is empty. */
  cameraId?: string | null;
  /** The estate row for `cameraId` (for the name strip); null when unknown. */
  camera?: EstateCamera | null;
  /** Which cell of the monitor this is. Accepted for the callers that pass it
   *  as a key/telemetry hint; the cell itself does not render it. */
  cellIndex?: number;
  profile?: string;
  control?: boolean;
  onAssign?: (cameraId: string) => void; // from a rail drag (control only)
  onClear?: () => void; // remove the camera (control only)
  onPick?: () => void; // click an empty cell to open the picker (control only)
}

export default function WallCell({
  cameraId,
  camera,
  profile = "sub",
  control = false,
  onAssign,
  onClear,
  onPick,
}: WallCellProps) {
  const [dropActive, setDropActive] = useState(false);

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!control) return;
    if (e.dataTransfer.types.includes("text/camera-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dropActive) setDropActive(true);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!control) return;
    e.preventDefault();
    setDropActive(false);
    const id = e.dataTransfer.getData("text/camera-id");
    if (id) onAssign?.(id);
  };

  // ── Empty cell ─────────────────────────────────────────────────────────
  if (!cameraId) {
    return (
      <div
        onDragOver={onDragOver}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
        onClick={control ? () => onPick?.() : undefined}
        className={`group relative flex min-h-0 items-center justify-center overflow-hidden bg-[#05080f] transition ${
          control ? "cursor-pointer" : ""
        } ${
          dropActive
            ? "outline outline-2 -outline-offset-2 outline-[#22d3ee]"
            : "outline outline-1 -outline-offset-1 outline-[rgba(160,150,245,.12)]"
        }`}
      >
        <Icon
          icon="heroicons:video-camera"
          className="text-lg text-[rgba(103,232,249,.12)] transition group-hover:text-[rgba(103,232,249,.4)]"
        />
        {control && (
          <span
            className={`pointer-events-none absolute bottom-1 font-mono text-[9px] font-medium text-[#67e8f9] transition-opacity ${
              dropActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {dropActive ? "Drop" : "+ Add"}
          </span>
        )}
      </div>
    );
  }

  // ── Filled cell ────────────────────────────────────────────────────────
  const name = camera?.name || "Camera";
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={() => setDropActive(false)}
      onDrop={onDrop}
      className={`group relative min-h-0 overflow-hidden bg-black transition ${
        dropActive ? "outline outline-2 -outline-offset-2 outline-[#22d3ee]" : "outline outline-1 -outline-offset-1 outline-[rgba(160,150,245,.18)]"
      }`}
    >
      <LivePlayer
        key={`${cameraId}:${profile}`}
        cameraId={cameraId}
        cameraName={name}
        profile={profile}
        minimal
        className="!rounded-none h-full w-full"
      />

      {/* Bottom info strip */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-1 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-5">
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-white/90">{name}</span>
      </div>

      {control && (
        <div className="absolute right-1 top-1 z-20 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
          <button
            type="button"
            title="Clear cell"
            onClick={(e) => {
              e.stopPropagation();
              onClear?.();
            }}
            className="rounded-sm bg-black/50 p-1 text-white/85 backdrop-blur-xs transition hover:bg-red-500/70 hover:text-white"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-[11px]" />
          </button>
        </div>
      )}
    </div>
  );
}
