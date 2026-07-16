"use client";

// One video-wall cell — redesigned for the P2-D control-room aesthetic.
//
// Empty tile: near-black, minimal. A faint centred camera glyph sits quietly;
// the "+ add camera" hint only surfaces on hover OR while the rail is dragging
// (so a 5×5 empty grid reads clean, not as 25 dashed "drop here" boxes).
//
// Filled tile: the LivePlayer full-bleed + a bottom GRADIENT STRIP (status dot,
// name, LIVE badge, optional timestamp) + a hover TOOLBAR (spotlight, snapshot,
// mute, remove) + a thin status-COLOURED top edge (online/offline/connecting).
// Double-click → spotlight. Tiles are drag SOURCES too, so dragging one tile
// onto another swaps them.
//
// Lifecycle: the LivePlayer only mounts when `cameraId` is set, and its
// useLiveSession releases the PlaybackSession on unmount — so removing a camera,
// paging a tour, or shrinking the layout tears the session down automatically.
// A tile promoted to spotlight KEEPS its cameraId (same LivePlayer key) so the
// session is reused, not restarted.
//
// ── Memo boundary (video-wall render-perf) ──────────────────────────────────
// WallTile is wrapped in React.memo so a re-render of the Streaming shell (SSE
// wall tick, a sibling tile's state, mute-all, drag) only re-renders the tiles
// whose OWN props changed. For the memo to hold, the parent must pass stable
// props: the callbacks are INDEX-BASED (`onSwap(fromIndex, index)`,
// `onSpotlight(index)`, `onClose(index)`, `onAssign(cameraId, index)`,
// `onPickHere(index)`) so a single useCallback'd handler is shared by every tile
// instead of a fresh per-render closure that captures `i`. The tile supplies its
// own stable `index` when invoking them.
import { memo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";
import LivePlayer from "./LivePlayer";
import PtzOverlay from "./PtzOverlay";
import { STATUS_PRESETS } from "../constants";
import { isPtzCapable } from "../formUtils";

const EDGE = {
  online: "bg-emerald-500",
  connecting: "bg-amber-500",
  error: "bg-red-500",
  offline: "bg-white/15",
  unknown: "bg-amber-500",
};

function WallTile({
  index,
  cameraId,
  camera,
  profile = "sub",
  isHero = false,
  spotlight = false, // fills the whole wall → room for the PTZ overlay
  railDragging = false,
  onAssign, // (cameraId, index) — from rail drag / picker
  onSwap, // (fromIndex, index) — from tile→tile drag
  onClose, // (index)
  onSpotlight, // (index) — promote this tile to fill the wall
  onPickHere, // (index) — open quick camera picker for an empty tile
  style,
}) {
  const rootRef = useRef(null);
  const [dropActive, setDropActive] = useState(false);
  const { can } = useAuth();

  const onDragOver = (e) => {
    // Accept both a rail camera and another tile being dragged over.
    if (e.dataTransfer.types.includes("text/camera-id") || e.dataTransfer.types.includes("text/tile-index")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!dropActive) setDropActive(true);
    }
  };
  const onDragLeave = () => setDropActive(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDropActive(false);
    const tileIdx = e.dataTransfer.getData("text/tile-index");
    if (tileIdx !== "" && tileIdx != null && String(tileIdx) !== String(index)) {
      onSwap?.(Number(tileIdx), index);
      return;
    }
    const id = e.dataTransfer.getData("text/camera-id");
    if (id) onAssign?.(id, index);
  };

  // ── Empty cell ───────────────────────────────────────────────────────────
  if (!cameraId) {
    const hinting = dropActive || railDragging;
    return (
      <div
        style={style}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => onPickHere?.(index)}
        className={`group/empty relative flex min-h-0 cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-black/90 transition ${
          dropActive
            ? "outline outline-2 outline-blue-500"
            : hinting
              ? "outline-dashed outline-1 outline-white/30"
              : "border border-white/15 hover:border-white/25"
        }`}
      >
        {/* Quiet centred glyph — always present, very faint. */}
        <Icon
          icon="heroicons:video-camera"
          className={`text-white/[0.06] transition group-hover/empty:text-white/15 ${
            isHero ? "text-5xl" : "text-2xl"
          }`}
        />
        {/* Hint appears only on hover or while dragging. */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 pb-2 text-[10px] font-medium text-white/50 transition-opacity ${
            hinting ? "opacity-100" : "opacity-0 group-hover/empty:opacity-100"
          }`}
        >
          <Icon icon="heroicons-mini:plus" className="text-xs" />
          {dropActive ? "Drop here" : "Add camera"}
        </div>
      </div>
    );
  }

  // ── Filled cell ────────────────────────────────────────────────────────────
  const name = camera?.name || "Camera";
  const status = camera?.status || "unknown";
  const preset = STATUS_PRESETS[status] || STATUS_PRESETS.unknown;
  const edge = EDGE[status] || EDGE.unknown;

  return (
    <div
      ref={rootRef}
      style={style}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/tile-index", String(index));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDoubleClick={() => onSpotlight?.(index)}
      className={`group relative min-h-0 overflow-hidden rounded-lg bg-black transition ${
        dropActive ? "outline outline-2 outline-blue-500" : "border border-white/15 hover:border-white/25"
      }`}
    >
      {/* Status-coloured top edge — sits just above the video INSIDE this tile
          only (z-[1]); the tile lives in the wall's z-0 stacking context so this
          never paints over the header account dropdown. */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 z-[1] h-[2px] ${edge}`} />

      {/* Player — full-bleed, minimal (the tile owns the overlays). */}
      <LivePlayer
        key={`${cameraId}:${profile}`}
        cameraId={cameraId}
        cameraName={name}
        profile={profile}
        minimal
        className="!rounded-none h-full w-full"
      />

      {/* Bottom gradient info strip */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-2 pb-1.5 pt-6">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${preset.dot}`} title={preset.label} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-white/90">{name}</span>
        {/* Site shows on the roomy hero tile; dense tiles stay to just the name.
            The state-aware LIVE badge is the player's own (top-left) — we don't
            duplicate it here so the strip never claims "live" while connecting. */}
        {isHero && camera?.site_name && (
          <span className="shrink-0 truncate text-[10px] text-white/45">{camera.site_name}</span>
        )}
      </div>

      {/* PTZ overlay — only when this tile fills the wall (spotlight) and the
          camera is PTZ-capable. Kept off dense grid tiles to avoid clutter.
          Stop drag/double-click from bubbling to the tile while operating it. */}
      {spotlight && isPtzCapable(camera) && (
        <div
          className="absolute bottom-3 left-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))]"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <PtzOverlay cameraId={cameraId} canControl={can("vms.ptz.control")} />
        </div>
      )}

      {/* Hover toolbar (top-right) */}
      <div className="absolute right-1.5 top-2 z-20 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <TileBtn
          icon="heroicons-outline:arrows-pointing-out"
          title="Spotlight (double-click)"
          onClick={() => onSpotlight?.(index)}
        />
        <TileBtn
          icon="heroicons-outline:x-mark"
          title="Remove from wall"
          danger
          onClick={() => onClose?.(index)}
        />
      </div>
    </div>
  );
}

// Memoised: a tile re-renders only when its OWN props change (its camera object,
// cameraId, flags, or the shared stable handlers) — not on every Streaming-shell
// render. This is what keeps a sibling tile's state change from cascading a
// render (and the WHEP re-attach risk) into every other tile's LivePlayer.
export default memo(WallTile);

function TileBtn({ icon, title, onClick, danger = false }) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={`rounded-md bg-black/50 p-1 text-white/85 backdrop-blur-sm transition hover:text-white ${
        danger ? "hover:bg-red-500/70" : "hover:bg-white/20"
      }`}
    >
      <Icon icon={icon} className="text-xs" />
    </button>
  );
}
