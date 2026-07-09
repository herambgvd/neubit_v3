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
import { useState } from "react";
import { Icon } from "@iconify/react";

import LivePlayer from "@/features/vms/components/LivePlayer";

export default function WallCell({
  cameraId,
  camera,
  cellIndex,
  profile = "sub",
  control = false,
  onAssign, // (cameraId) — from a rail drag (control only)
  onClear, // () — remove the camera (control only)
  onPick, // () — click an empty cell to open the picker (control only)
}) {
  const [dropActive, setDropActive] = useState(false);

  const onDragOver = (e) => {
    if (!control) return;
    if (e.dataTransfer.types.includes("text/camera-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!dropActive) setDropActive(true);
    }
  };
  const onDrop = (e) => {
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
        className={`group relative flex min-h-0 items-center justify-center overflow-hidden bg-[#0a0a0b] transition ${
          control ? "cursor-pointer" : ""
        } ${
          dropActive
            ? "outline outline-2 -outline-offset-2 outline-blue-500"
            : "outline outline-1 -outline-offset-1 outline-white/[0.04]"
        }`}
      >
        <Icon
          icon="heroicons:video-camera"
          className="text-lg text-white/[0.06] transition group-hover:text-white/15"
        />
        {control && (
          <span
            className={`pointer-events-none absolute bottom-1 text-[9px] font-medium text-white/50 transition-opacity ${
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
        dropActive ? "outline outline-2 -outline-offset-2 outline-blue-500" : "outline outline-1 -outline-offset-1 outline-white/[0.06]"
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
            className="rounded bg-black/50 p-1 text-white/85 backdrop-blur-sm transition hover:bg-red-500/70 hover:text-white"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-[11px]" />
          </button>
        </div>
      )}
    </div>
  );
}
