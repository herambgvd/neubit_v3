"use client";

// PlaybackTileView — one camera in the Playback grid (SCRUM-306).
//
// The recording itself is TilePlayback, the same engine the live wall plays back
// with. Around it: the camera's name and recorder, whether it follows the grid or
// plays on its own, and the per-tile tools every VMS client puts on a tile —
// independent playback, digital zoom, snapshot, audio, maximise, remove.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import TilePlayback from "../components/TilePlayback";
import type { EstateCamera, PlaybackStream } from "../types";
import { clockText, localDay } from "./playbackModel";
import type { Controller, PlaybackCam } from "./usePlaybackWorkspace";

export interface PlaybackTileViewProps {
  cam: PlaybackCam;
  ctl: Controller;
  /** This tile publishes its controller's clock (exactly one per controller). */
  master: boolean;
  active: boolean;
  independent: boolean;
  stream: PlaybackStream;
  rateMax: number;
  audio: boolean;
  compact: boolean;
  maximised: boolean;
  onActivate: (key: string) => void;
  onRemove: (key: string) => void;
  onToggleIndependent: (key: string) => void;
  onToggleAudio: (key: string) => void;
  onToggleMaximise: (key: string) => void;
  onReachedEnd: (ctlId: string, atMs: number) => void;
}

// Digital zoom: 1× … 8×, like the zoom every client offers on a recorded tile.
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.2;

interface ZoomState {
  s: number;
  x: number;
  y: number;
}
const NO_ZOOM: ZoomState = { s: 1, x: 0, y: 0 };

function PlaybackTileView({
  cam,
  ctl,
  master,
  active,
  independent,
  stream,
  rateMax,
  audio,
  compact,
  maximised,
  onActivate,
  onRemove,
  onToggleIndependent,
  onToggleAudio,
  onToggleMaximise,
  onReachedEnd,
}: Readonly<PlaybackTileViewProps>) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [zoomOn, setZoomOn] = useState(false);
  const [zoom, setZoom] = useState<ZoomState>(NO_ZOOM);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const camera = useMemo<EstateCamera>(
    () => ({ id: cam.key, name: cam.name, federated: true, node_id: cam.nodeId, real_id: cam.realId }),
    [cam.key, cam.name, cam.nodeId, cam.realId],
  );

  // ── digital zoom ────────────────────────────────────────────────────────
  const clampPan = useCallback((z: ZoomState): ZoomState => {
    const el = rootRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    return {
      s: z.s,
      x: Math.min(0, Math.max(w - w * z.s, z.x)),
      y: Math.min(0, Math.max(h - h * z.s, z.y)),
    };
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !zoomOn) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setZoom((z) => {
        const s = Math.min(ZOOM_MAX, Math.max(1, e.deltaY < 0 ? z.s * ZOOM_STEP : z.s / ZOOM_STEP));
        // Keep the point under the cursor where it is.
        return clampPan({ s, x: cx - ((cx - z.x) * s) / z.s, y: cy - ((cy - z.y) * s) / z.s });
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomOn, clampPan]);

  const toggleZoom = () => {
    setZoomOn((on) => !on);
    setZoom(NO_ZOOM);
  };

  // ── snapshot ────────────────────────────────────────────────────────────
  const snapshot = () => {
    const v = rootRef.current?.querySelector("video");
    if (!v?.videoWidth) return;
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      const at = ctl.clock.get() ?? Date.now();
      c.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${cam.name}-${localDay(at)}_${clockText(at).replaceAll(":", "-")}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    } catch {
      /* a frame the browser will not hand to a canvas: nothing to save */
    }
  };

  return (
    // A tile is a group of controls, activated by a click anywhere on it, as every
    // VMS grid works; the buttons inside are the keyboard path.
    <div
      ref={rootRef}
      onPointerDown={(e) => {
        onActivate(cam.key);
        if (zoomOn && zoom.s > 1) {
          dragRef.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        dragRef.current = { x: e.clientX, y: e.clientY };
        setZoom((z) => clampPan({ ...z, x: z.x + dx, y: z.y + dy }));
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onDoubleClick={() => onToggleMaximise(cam.key)}
      className={`group relative h-full min-h-0 overflow-hidden rounded-lg bg-black ring-inset ${
        active ? "ring-2 ring-[#22d3ee]" : "ring-1 ring-[rgba(160,150,245,.18)]"
      } ${zoomOn ? "cursor-move" : ""}`}
    >
      <div
        className="absolute inset-0 origin-top-left"
        style={zoom.s > 1 ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}
      >
        <TilePlayback
          camera={camera}
          anchorMs={ctl.anchorMs}
          anchorSeq={ctl.anchorSeq}
          windowToMs={Number.MAX_SAFE_INTEGER}
          playing={ctl.playing && ctl.speed > 0}
          speed={Math.max(ctl.speed, 0.25)}
          master={master}
          clock={ctl.clock}
          muted={!audio}
          compact={compact}
          stream={stream}
          rateMax={rateMax}
          scrubMs={ctl.scrubMs}
          scrubSeq={ctl.scrubSeq}
          onReachedEnd={(at) => onReachedEnd(ctl.id, at)}
        />
      </div>

      {/* Name, recorder and how this tile keeps time */}
      <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex max-w-[70%] items-center gap-1">
        <span className="truncate rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {cam.name}
          {!compact && <span className="ml-1 font-normal text-white/55">· {cam.recorder}</span>}
        </span>
        {independent ? (
          <span className="rounded bg-amber-500/85 px-1 py-0.5 text-[9px] font-bold uppercase text-black">Ind</span>
        ) : null}
        {zoom.s > 1 && (
          <span className="rounded bg-black/65 px-1 py-0.5 text-[9px] font-semibold text-[#67e8f9]">
            {zoom.s.toFixed(1)}×
          </span>
        )}
      </div>

      {/* Tile tools — on hover, and always on the active tile */}
      <div
        className={`absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 transition-opacity ${
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <TileBtn
          icon={independent ? "heroicons-outline:link" : "heroicons-outline:link-slash"}
          title={independent ? "Sync with the grid again" : "Play independently of the grid"}
          on={independent}
          onClick={() => onToggleIndependent(cam.key)}
        />
        <TileBtn
          icon="heroicons-outline:magnifying-glass-plus"
          title={zoomOn ? "Digital zoom off" : "Digital zoom (wheel to zoom, drag to move)"}
          on={zoomOn}
          onClick={toggleZoom}
        />
        <TileBtn icon="heroicons-outline:camera" title="Snapshot of this frame" onClick={snapshot} />
        <TileBtn
          icon={audio ? "heroicons-outline:speaker-wave" : "heroicons-outline:speaker-x-mark"}
          title={audio ? "Mute" : "Play this tile's audio"}
          on={audio}
          onClick={() => onToggleAudio(cam.key)}
        />
        <TileBtn
          icon={maximised ? "heroicons-outline:arrows-pointing-in" : "heroicons-outline:arrows-pointing-out"}
          title={maximised ? "Back to the grid" : "Maximise (double-click)"}
          onClick={() => onToggleMaximise(cam.key)}
        />
        <TileBtn icon="heroicons-outline:x-mark" title="Remove from playback" onClick={() => onRemove(cam.key)} />
      </div>
    </div>
  );
}

interface TileBtnProps {
  icon: string;
  title: string;
  on?: boolean;
  onClick: () => void;
}

function TileBtn({ icon, title, on = false, onClick }: Readonly<TileBtnProps>) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`inline-flex h-6 w-6 items-center justify-center rounded bg-black/65 transition hover:bg-black/85 ${
        on ? "text-[#67e8f9]" : "text-white/85"
      }`}
    >
      <Icon icon={icon} className="text-[13px]" />
    </button>
  );
}

export default memo(PlaybackTileView);
