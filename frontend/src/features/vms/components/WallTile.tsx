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
import { memo, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";
import { vms } from "../api";
import LivePlayer, { PlayerBtn } from "./LivePlayer";
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
  onAssignMany, // (cameraIds[], index) — a whole rail branch dropped here
  onSwap, // (fromIndex, index) — from tile→tile drag
  onClose, // (index)
  onSpotlight, // (index) — promote this tile to fill the wall
  onPickHere, // (index) — open quick camera picker for an empty tile
  style,
}: any) {
  const rootRef = useRef<any>(null);
  const [dropActive, setDropActive] = useState(false);
  const { can } = useAuth();

  // Federated (recorder-owned) cameras stream THROUGH their node: mint/renew a
  // node-issued live token via /vms/federation. Local VMS cameras use LivePlayer's
  // default source (undefined). Stable per (node, real id) so the player doesn't
  // re-attach on every wall render.
  const fedNodeId = camera?.federated ? camera.node_id : null;
  const fedRealId = camera?.federated ? camera.real_id : null;
  const source = useMemo(() => {
    if (!fedNodeId || !fedRealId) return undefined;
    const mint = async (profile) => {
      const s = await vms.federation.live(fedNodeId, fedRealId, profile);
      return { ...s, ready: true };
    };
    return {
      start: (_camId, profile) => mint(profile),
      renew: () => mint("sub"),
      release: async () => {},
    };
  }, [fedNodeId, fedRealId]);

  const onDragOver = (e) => {
    // Accept a rail camera, a whole rail branch (a recorder), or another tile.
    const types = e.dataTransfer.types;
    const fromTile = types.includes("text/tile-index");
    const fromRail = types.includes("text/camera-id") || types.includes("text/camera-ids");
    if (!fromTile && !fromRail) return;

    e.preventDefault();
    // dropEffect MUST agree with the source's effectAllowed. A mismatch resolves
    // to "none" and the browser then refuses the drop — silently, and AFTER
    // preventDefault, so the tile still highlights and still says DROP HERE while
    // nothing can ever land on it. That is exactly what a hardcoded "move" did to
    // every drag out of the rail, which marks its drags "copy" (the camera stays
    // in the list). Tile-to-tile was unaffected and hid the bug: WallTile's own
    // dragstart says "move", which agreed with the constant.
    //
    // So the effect follows the SOURCE: a tile being rearranged moves, a camera
    // being taken from the rail copies.
    e.dataTransfer.dropEffect = fromTile ? "move" : "copy";
    if (!dropActive) setDropActive(true);
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
    // A whole branch: fill from THIS tile onward, so where the operator dropped
    // decides where the recorder lands rather than always the top-left.
    const many = e.dataTransfer.getData("text/camera-ids");
    if (many) {
      try {
        const ids = JSON.parse(many);
        if (Array.isArray(ids) && ids.length) {
          onAssignMany?.(ids, index);
          return;
        }
      } catch {
        // A malformed payload is not worth failing a drop over; fall through to
        // the single-camera path, which will simply find nothing and no-op.
      }
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
        className={`group/empty relative flex min-h-0 cursor-pointer items-center justify-center overflow-hidden rounded-[11px] bg-black/90 transition ${
          dropActive
            ? "outline outline-2 outline-[#22d3ee]"
            : hinting
              ? "outline-dashed outline-1 outline-[rgba(34,211,238,.4)]"
              : "border border-[rgba(150,180,245,.22)] hover:border-[#22d3ee]"
        }`}
      >
        {/* Quiet centred glyph — always present, very faint. */}
        <Icon
          icon="heroicons:video-camera"
          className={`text-[rgba(103,232,249,.1)] transition group-hover/empty:text-[rgba(103,232,249,.3)] ${
            isHero ? "text-5xl" : "text-2xl"
          }`}
        />
        {/* Hint appears only on hover or while dragging. */}
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 pb-2 font-mono text-[10px] font-medium uppercase tracking-[1px] text-[#67e8f9]/70 transition-opacity ${
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
      className={`group relative min-h-0 overflow-hidden rounded-[11px] bg-black transition ${
        dropActive ? "outline outline-2 outline-[#22d3ee]" : "border border-[rgba(150,180,245,.22)] hover:border-[#22d3ee]"
      }`}
    >
      {/* Status-coloured top edge — sits just above the video INSIDE this tile
          only (z-[1]); the tile lives in the wall's z-0 stacking context so this
          never paints over the header account dropdown. */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 z-[1] h-[2px] ${edge}`} />

      {/* Scanline texture (mockup) — a barely-there CRT sheen for the control-room
          look; never intercepts pointer events. */}
      <div
        className="pointer-events-none absolute inset-0 z-[2]"
        style={{ background: "repeating-linear-gradient(0deg,rgba(255,255,255,.02) 0 1px,transparent 1px 4px)" }}
      />

      {/* Source badge (mockup) — the recorder/node this camera streams through.
          Real data only (federated cameras carry node_name); omitted for local
          cameras so we never invent a source. */}
      {camera?.node_name && (
        <span className="pointer-events-none absolute right-2 top-2 z-10 rounded-[7px] border border-white/20 bg-black/35 px-1.5 py-px font-mono text-[10px] text-[#d7f7e9] backdrop-blur-xs">
          {camera.node_name}
        </span>
      )}

      {/* Player — full-bleed, minimal (the tile owns the overlays). */}
      <LivePlayer
        key={`${cameraId}:${profile}`}
        cameraId={camera?.federated ? camera.real_id : cameraId}
        cameraName={name}
        profile={profile}
        source={source}
        minimal
        fit="contain"
        className="!rounded-none h-full w-full"
        extraControls={
          <>
            <PlayerBtn icon="heroicons-outline:arrows-pointing-out" title="Spotlight (double-click)" onClick={() => onSpotlight?.(index)} />
            <PlayerBtn icon="heroicons-outline:x-mark" title="Remove from wall" onClick={() => onClose?.(index)} />
          </>
        }
      />

      {/* Bottom gradient info strip — slim (mockup): name + status only. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${preset.dot}`} title={preset.label} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] tracking-[.3px] text-[#d7f7e9]">{name}</span>
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
      {spotlight && (isPtzCapable(camera) || camera?.federated) && (
        <div
          className="absolute bottom-3 left-3 z-30 max-w-[min(28rem,calc(100%-1.5rem))]"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {/* Federated cameras route PTZ THROUGH their owning recorder (operate-
              through-node); local cameras use the local control plane. */}
          <PtzOverlay
            cameraId={camera?.federated ? camera.real_id : cameraId}
            canControl={can("vms.ptz.control")}
            fedNodeId={camera?.federated ? camera.node_id : null}
            fedRealId={camera?.federated ? camera.real_id : null}
          />
        </div>
      )}

    </div>
  );
}

// Memoised: a tile re-renders only when its OWN props change (its camera object,
// cameraId, flags, or the shared stable handlers) — not on every Streaming-shell
// render. This is what keeps a sibling tile's state change from cascading a
// render (and the WHEP re-attach risk) into every other tile's LivePlayer.
export default memo(WallTile);
