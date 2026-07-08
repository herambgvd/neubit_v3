"use client";

// One video-wall cell. Empty → a drop/click target ("Add camera"); filled →
// a LivePlayer with a per-tile header (status dot, name, snapshot, fullscreen,
// close). Ported from neubit_v2's `stream-cell.jsx`, simplified to P2-D scope
// (no recording/push-to-display yet — those are P3+) and rethemed to v3 tokens.
//
// Lifecycle: the LivePlayer only mounts when `cameraId` is set, and its
// useLiveSession releases the PlaybackSession on unmount — so removing a camera
// or paging a tour tears the session down without extra bookkeeping here.
import { useRef } from "react";
import { Icon } from "@iconify/react";

import LivePlayer from "./LivePlayer";
import { StatusDot } from "./StatusBadge";

export default function WallTile({ index, cameraId, camera, profile = "sub", onAssign, onClose }) {
  const rootRef = useRef(null);
  const dragOver = useRef(false);

  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragOver.current = false;
    const id = e.dataTransfer.getData("text/camera-id");
    if (id) onAssign?.(id);
  };

  const goFullscreen = () => rootRef.current?.requestFullscreen?.();

  // Empty cell — drop target.
  if (!cameraId) {
    return (
      <div
        onDragOver={onDragOver}
        onDrop={onDrop}
        className="flex h-full min-h-0 w-full items-center justify-center rounded-lg border-2 border-dashed border-card-border bg-card/40 text-center text-muted transition hover:border-muted"
      >
        <span className="px-3 text-xs">
          Drop a camera here
          <span className="mt-0.5 block text-[10px] opacity-60">Tile {index + 1}</span>
        </span>
      </div>
    );
  }

  const name = camera?.name || "Camera";
  const status = camera?.status || "unknown";

  return (
    <div
      ref={rootRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className="group relative flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-card-border bg-black"
    >
      {/* Tile header */}
      <div className="flex items-center justify-between gap-2 bg-black/70 px-2 py-1.5 text-white">
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusDot status={status} />
          <span className="truncate text-xs font-medium">{name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition group-hover:opacity-100">
          <button
            type="button"
            title="Fullscreen"
            onClick={goFullscreen}
            className="rounded p-1 text-white/90 hover:bg-white/15"
          >
            <Icon icon="heroicons-outline:arrows-pointing-out" className="text-xs" />
          </button>
          <button
            type="button"
            title="Remove from wall"
            onClick={() => onClose?.()}
            className="rounded p-1 text-white/90 hover:bg-red-500/60"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-xs" />
          </button>
        </div>
      </div>

      {/* Player — minimal chrome; the tile header owns name/controls. Snapshot
          + mute live in the player's own hover chrome via `minimal={false}`
          only on the 1×1 layout; dense tiles stay clean with `minimal`. */}
      <div className="relative min-h-0 flex-1">
        <LivePlayer
          key={`${cameraId}:${profile}`}
          cameraId={cameraId}
          cameraName={name}
          profile={profile}
          minimal
          className="h-full rounded-none"
        />
      </div>
    </div>
  );
}
