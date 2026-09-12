"use client";

// Floor-plan canvas — ported from neubit_v2. Renders the floorplan image and lets
// the operator draw zone polygons (click to add points, click-near-start or Enter to
// close, Esc to cancel). Pan (alt/middle-drag or empty-drag) + wheel-zoom.
//
// Device-placement paths (drag-drop / move / rotate / FoV) are retained but DORMANT:
// neubit_v3 has no devices backend yet, so `devices` is always [] and the parent editor
// never enters DEVICE_PLACE mode. The device code stays so re-enabling is a one-liner in
// the devices phase — including its keyboard path, which the key table below does not
// try to guess: that table covers the view and zone drawing, the two things that exist.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { fileUrl } from "@/lib/api";
import { EDITOR_MODES, TOOL_TYPES } from "@/components/floor-builder/constants";
import type { DeviceRendererArgs, RenderableDevice } from "@/components/floor-builder/cameraRenderer";
import type {
  DevicePayload,
  EditorMode,
  EditorPlacement,
  EditorZone,
  FloorPoint,
  PlaceableDevice,
  ToolType,
} from "@/components/floor-builder/types";

const HIT_RADIUS = 8; // px in screen space

// ── Geometry helpers ──────────────────────────────────────────────────
// Points are `[x, y]` in WORLD coords (image-space pixels) — the same `number[]`
// shape a zone's polygon comes off the wire as.

function pointInPolygon(pt: number[], points: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersect =
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function distance(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalizeAngleRad(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function isPointInDeviceFov(device: RenderableDevice, worldPt: number[]): boolean {
  const cx = device.x ?? 0;
  const cy = device.y ?? 0;
  const dx = worldPt[0] - cx;
  const dy = worldPt[1] - cy;
  const dist = Math.hypot(dx, dy);
  const coverage = device.coverage_radius ?? 60;
  if (dist > coverage) return false;

  const rotationDeg = device.rotation ?? 0;
  const fovDeg = device.fov ?? 70;
  const half = (fovDeg / 2) * (Math.PI / 180);
  const facing = (rotationDeg - 90) * (Math.PI / 180);
  const pointAngle = Math.atan2(dy, dx);
  const delta = normalizeAngleRad(pointAngle - facing);
  return Math.abs(delta) <= half;
}

/** Where a camera's rotation grip sits. The offset is in SCREEN pixels — hence the
 *  /scale — so the grip stays the same size to grab however far the plan is zoomed
 *  out. Shared so the grab and the cursor that promises it can never disagree. */
function rotationHandleWorld(device: RenderableDevice, scale: number): [number, number] {
  const rot = (device.rotation ?? 0) * (Math.PI / 180);
  const handleR = 28 / scale;
  return [
    (device.x ?? 0) + Math.cos(rot - Math.PI / 2) * handleR,
    (device.y ?? 0) + Math.sin(rot - Math.PI / 2) * handleR,
  ];
}

function pointInAnyZone(worldPt: number[], zones: EditorZone[] = []): boolean {
  if (!zones.length) return false;
  return zones.some(
    (z) => z.polygon && z.polygon.length >= 3 && pointInPolygon(worldPt, z.polygon),
  );
}

// ── Keyboard model ────────────────────────────────────────────────────

/** Screen-pixel steps. A pan has to cross a plan in a few presses; a crosshair
 *  step is small because a point is usually wanted on a wall, and Shift drops it
 *  to a single pixel for the last bit. */
const PAN_STEP = 48;
const CURSOR_STEP = 8;

const CURSOR_AXES: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

// The view offset moves against the key: ArrowRight looks further right, which
// slides the plan left under a fixed viewport.
const PAN_AXES: Record<string, [number, number]> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

/** What a key does on the canvas — `dx`/`dy` are screen pixels. */
export type CanvasKeyAction =
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "cursor"; dx: number; dy: number }
  | { kind: "addPoint" }
  | { kind: "undoPoint" }
  | { kind: "zoom"; factor: number }
  | { kind: "fit" };

/** What an arrow key means, which is the one key on the canvas that means two
 *  things — and carries the two step sizes that go with them. Out of the table
 *  below because it is the only branch in it, and the table reads as a table
 *  once it is gone. Only called for a key the axis maps know. */
function arrowAction(
  key: string,
  mods: { shiftKey?: boolean; altKey?: boolean },
  drawing: boolean,
): CanvasKeyAction {
  if (drawing && !mods.altKey) {
    const [ax, ay] = CURSOR_AXES[key];
    const step = mods.shiftKey ? 1 : CURSOR_STEP;
    return { kind: "cursor", dx: ax * step, dy: ay * step };
  }
  const [px, py] = PAN_AXES[key];
  const step = mods.shiftKey ? PAN_STEP * 4 : PAN_STEP;
  return { kind: "pan", dx: px * step, dy: py * step };
}

/** Where a key press takes the canvas, or null for a key it does not claim.
 *
 *  The arrows mean two things because the canvas does: while a polygon is being
 *  drawn they walk a crosshair over the plan — placing a point is the one thing
 *  an operator cannot otherwise do without a pointer — and the rest of the time
 *  they pan. Alt pans either way, the same modifier that pans with the mouse.
 *
 *  Enter and Escape are deliberately NOT claimed: the window-level draft handler
 *  already closes and cancels a polygon from the keyboard, and claiming them here
 *  would close the zone twice. Nor is anything with Ctrl/Cmd — the editor above
 *  owns undo/redo, and the browser owns the rest.
 *
 *  Out here rather than inside the handler because this table IS the keyboard
 *  interaction, and it is worth reading — and testing — without a DOM. */
export function canvasKeyAction(
  key: string,
  mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean },
  ctx: { drawing: boolean; draftCount: number },
): CanvasKeyAction | null {
  if (mods.ctrlKey || mods.metaKey) return null;

  if (CURSOR_AXES[key]) return arrowAction(key, mods, ctx.drawing);

  if (ctx.drawing && key === " ") return { kind: "addPoint" };
  if (ctx.drawing && ctx.draftCount > 0 && (key === "Backspace" || key === "Delete"))
    return { kind: "undoPoint" };

  if (key === "+" || key === "=") return { kind: "zoom", factor: 1.2 };
  if (key === "-" || key === "_") return { kind: "zoom", factor: 1 / 1.2 };
  if (key === "0") return { kind: "fit" };

  return null;
}

// ── Component ─────────────────────────────────────────────────────────

/** What the parent drives through the ref. */
export interface FloorPlanCanvasHandle {
  setScale: (scale: number) => void;
  resetView: () => void;
  cancelDraft: () => void;
  finishDraft: () => void;
}

export interface FloorPlanCanvasProps {
  floorplanUrl?: string | null;
  zones?: EditorZone[];
  devices?: EditorPlacement[];
  editorMode?: EditorMode;
  activeTool?: ToolType;
  selectedZoneId?: string | null;
  selectedDeviceId?: string | null;
  onSelectZone?: (zone: EditorZone) => void;
  onSelectDevice?: (device: EditorPlacement) => void;
  /** The closed polygon, `[[x,y],...]`. */
  onZoneCreate?: (points: number[][]) => void;
  onDeviceCreate?: (point: FloorPoint) => void;
  /** Palette drag-drop. */
  onDeviceDrop?: (drop: { payload: DevicePayload; point: FloorPoint }) => void;
  /** Dropped outside every zone. */
  onInvalidDrop?: () => void;
  /** The device currently dragged from the palette — drawn as a ghost at the cursor. */
  dragPreview?: PlaceableDevice | null;
  onDeviceMove?: (device: EditorPlacement, point: FloorPoint) => void;
  onDeviceRotate?: (device: EditorPlacement, rotation: number) => void;
  /** Single click without drag. */
  onDeviceClick?: (device: EditorPlacement) => void;
  /** Optional per-device renderer; the default draws a plain dot. */
  deviceRenderer?: (args: DeviceRendererArgs) => void;
}

/** An in-progress pointer drag on a device. `move` tracks the world offset from
 *  where the drag began; `rotate` only needs the starting angle. */
type DragState =
  | { device: EditorPlacement; mode: "move"; origWorld: number[]; startWorld: number[]; moved: boolean; changed: boolean }
  | { device: EditorPlacement; mode: "rotate"; origRotation: number; moved: boolean; changed: boolean };

type MoveDrag = Extract<DragState, { mode: "move" }>;
type RotateDrag = Extract<DragState, { mode: "rotate" }>;

/** Where a palette drag is over the canvas, and whether it is a legal drop. */
interface DropHover {
  world: number[];
  zoneId: string | null;
  valid: boolean;
}

export const FloorPlanCanvas = forwardRef<FloorPlanCanvasHandle, FloorPlanCanvasProps>(function FloorPlanCanvas(
  {
    floorplanUrl,
    zones = [],
    devices = [],
    editorMode = EDITOR_MODES.VIEW,
    activeTool = TOOL_TYPES.SELECT,
    selectedZoneId = null,
    selectedDeviceId = null,
    onSelectZone,
    onSelectDevice,
    onZoneCreate,
    onDeviceCreate,
    onDeviceDrop,
    onInvalidDrop,
    dragPreview = null,
    onDeviceMove,
    onDeviceRotate,
    onDeviceClick,
    deviceRenderer,
  },
  ref,) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

  // View transform: translate (px) + scale.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Drawing state — points in WORLD coords (image-space pixels).
  const [draftPoints, setDraftPoints] = useState<number[][]>([]);
  const [hoverWorld, setHoverWorld] = useState<number[] | null>(null);

  // Device drag state
  const dragRef = useRef<DragState | null>(null);
  const [hoverRotationHandle, setHoverRotationHandle] = useState(false);
  const [hoverRotationFov, setHoverRotationFov] = useState(false);
  const [hoverDeviceId, setHoverDeviceId] = useState<string | null>(null);

  // Palette drag-drop feedback: where the cursor is, and whether that point is a
  // legal drop (inside a zone). Drives the ghost glyph + the hovered-zone highlight.
  // `null` whenever no palette drag is over the canvas.
  const [dropHover, setDropHover] = useState<DropHover | null>(null);

  // The keyboard crosshair, in WORLD coords — where Space drops the next polygon
  // point. `null` until the arrows are used, so a pointer operator never sees it.
  const [keyCursor, setKeyCursor] = useState<number[] | null>(null);

  // ── Imperative API ────────────────────────────────────────────────
  useImperativeHandle(
    ref,
    () => ({
      setScale,
      resetView: () => {
        setScale(1);
        setOffset({ x: 0, y: 0 });
        fitToContainer();
      },
      cancelDraft: () => setDraftPoints([]),
      finishDraft: () => {
        if (draftPoints.length >= 3) {
          onZoneCreate?.(draftPoints);
          setDraftPoints([]);
        }
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draftPoints, onZoneCreate],
  );

  // ── Load background image ─────────────────────────────────────────

  useEffect(() => {
    if (!floorplanUrl) {
      setImgEl(null);
      setImgSize({ w: 0, h: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => {
      setImgEl(img);
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      setImgEl(null);
      setImgSize({ w: 0, h: 0 });
    };
    // fileUrl returns null for an empty ref; the effect guards on floorplanUrl
    // above, so this is only ever a real path here.
    img.src = fileUrl(floorplanUrl) ?? "";
  }, [floorplanUrl]);

  // ── Fit to container on first load ────────────────────────────────

  const fitToContainer = useCallback(() => {
    const container = containerRef.current;
    if (!container || !imgSize.w || !imgSize.h) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const s = Math.min(cw / imgSize.w, ch / imgSize.h, 1) * 0.95;
    setScale(s);
    setOffset({
      x: (cw - imgSize.w * s) / 2,
      y: (ch - imgSize.h * s) / 2,
    });
  }, [imgSize]);

  useLayoutEffect(() => {
    fitToContainer();
  }, [fitToContainer]);

  // ── Coordinate conversions ────────────────────────────────────────

  const screenToWorld = useCallback(
    (sx: number, sy: number): [number, number] => [(sx - offset.x) / scale, (sy - offset.y) / scale],
    [offset, scale],
  );
  const worldToScreen = useCallback(
    (wx: number, wy: number): [number, number] => [wx * scale + offset.x, wy * scale + offset.y],
    [offset, scale],
  );

  /** Zoom about a point in screen space, keeping what is under it put. Shared by
   *  the wheel (about the cursor) and the +/- keys (about the middle). */
  const zoomAt = useCallback((sx: number, sy: number, factor: number) => {
    setScale((prevScale) => {
      const next = Math.max(0.1, Math.min(5, prevScale * factor));
      setOffset((prevOff) => {
        const wx = (sx - prevOff.x) / prevScale;
        const wy = (sy - prevOff.y) / prevScale;
        return { x: sx - wx * next, y: sy - wy * next };
      });
      return next;
    });
  }, []);

  // ── Render ────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Background
    if (imgEl && imgSize.w) {
      ctx.drawImage(imgEl, offset.x, offset.y, imgSize.w * scale, imgSize.h * scale);
    } else {
      // Fallback grid — neutral so it reads on both light + dark shells.
      ctx.fillStyle = "rgba(120,120,130,0.06)";
      ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = "rgba(120,120,130,0.18)";
      ctx.lineWidth = 1;
      const step = 40 * scale;
      for (let x = offset.x % step; x < cw; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
        ctx.stroke();
      }
      for (let y = offset.y % step; y < ch; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(140,140,150,0.9)";
      ctx.font = "13px system-ui";
      ctx.fillText("No floorplan uploaded — upload an image to start", 16, 24);
    }

    // Zones
    for (const zone of zones) {
      const pts = zone.polygon || [];
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach(([wx, wy], i) => {
        const [sx, sy] = worldToScreen(wx, wy);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      const isSelected = zone.zone_id === selectedZoneId;
      // While dragging a device from the palette, the zone under the cursor lights up
      // (stronger fill + dashed outline) so the legal drop target is unmistakable.
      const isDropTarget = !!dropHover?.zoneId && zone.zone_id === dropHover.zoneId;
      ctx.fillStyle = (zone.color || "#2563eb") + (isDropTarget ? "55" : "33");
      ctx.fill();
      ctx.lineWidth = isDropTarget ? 3 : isSelected ? 3 : 2;
      ctx.strokeStyle = zone.color || "#2563eb";
      if (isDropTarget) ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Vertex handles when selected and editable
      if (isSelected && editorMode === EDITOR_MODES.ZONE_DRAW) {
        for (const [wx, wy] of pts) {
          const [sx, sy] = worldToScreen(wx, wy);
          ctx.beginPath();
          ctx.arc(sx, sy, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#fff";
          ctx.strokeStyle = zone.color || "#2563eb";
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();
        }
      }

      // Label
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      const [lx, ly] = worldToScreen(cx, cy);
      ctx.fillStyle = "rgba(15,23,42,0.85)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      // Small white halo so the label stays legible over the translucent fill.
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.strokeText(zone.name || "Zone", lx, ly);
      ctx.fillText(zone.name || "Zone", lx, ly);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // Draft polygon (in-progress drawing)
    if (
      editorMode === EDITOR_MODES.ZONE_DRAW &&
      activeTool === TOOL_TYPES.ZONE_POLYGON &&
      draftPoints.length > 0
    ) {
      ctx.beginPath();
      draftPoints.forEach(([wx, wy], i) => {
        const [sx, sy] = worldToScreen(wx, wy);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      if (hoverWorld) {
        const [sx, sy] = worldToScreen(hoverWorld[0], hoverWorld[1]);
        ctx.lineTo(sx, sy);
      }
      ctx.strokeStyle = "#2563eb";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      for (const [wx, wy] of draftPoints) {
        const [sx, sy] = worldToScreen(wx, wy);
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#2563eb";
        ctx.fill();
      }
    }

    // Keyboard crosshair — the pointer's stand-in. Without something drawn here
    // the arrows would be moving an invisible thing, which is worse than having
    // no keyboard path at all.
    if (
      editorMode === EDITOR_MODES.ZONE_DRAW &&
      activeTool === TOOL_TYPES.ZONE_POLYGON &&
      keyCursor
    ) {
      const [cx, cy] = worldToScreen(keyCursor[0], keyCursor[1]);
      ctx.save();
      // White underlay first, so the cross reads over a dark floor plan too.
      for (const [color, width] of [["rgba(255,255,255,0.9)", 4], ["#2563eb", 1.5]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(cx - 11, cy);
        ctx.lineTo(cx + 11, cy);
        ctx.moveTo(cx, cy - 11);
        ctx.lineTo(cx, cy + 11);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Devices (dormant — devices is always [] until the devices phase)
    for (const dev of devices) {
      const isSelected = dev.device_id === selectedDeviceId;
      if (deviceRenderer) {
        deviceRenderer({ ctx, device: dev, isSelected, scale, worldToScreen });
        continue;
      }
      const [sx, sy] = worldToScreen(dev.x ?? 0, dev.y ?? 0);
      ctx.beginPath();
      ctx.arc(sx, sy, 8, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? "#2563eb" : "#475569";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Palette-drag ghost — the device is previewed at the cursor with the same glyph
    // it will have once placed (cone included), so there's no surprise on drop. Over
    // an illegal spot it turns into a red no-drop marker instead.
    if (dropHover) {
      const [gx, gy] = worldToScreen(dropHover.world[0], dropHover.world[1]);
      ctx.save();
      if (dropHover.valid) {
        ctx.globalAlpha = 0.55;
        if (deviceRenderer && dragPreview) {
          deviceRenderer({
            ctx,
            device: {
              ...dragPreview,
              x: dropHover.world[0],
              y: dropHover.world[1],
              rotation: 0,
            },
            isSelected: false,
            scale,
            worldToScreen,
          });
        } else {
          ctx.beginPath();
          ctx.arc(gx, gy, 9, 0, Math.PI * 2);
          ctx.fillStyle = "#2563eb";
          ctx.fill();
        }
      } else {
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(gx, gy, 11, 0, Math.PI * 2);
        ctx.strokeStyle = "#dc2626";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        // Slash through the circle — the universal "can't drop here".
        const d = 11 * Math.SQRT1_2;
        ctx.beginPath();
        ctx.moveTo(gx - d, gy - d);
        ctx.lineTo(gx + d, gy + d);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [
    imgEl,
    imgSize,
    offset,
    scale,
    zones,
    devices,
    selectedZoneId,
    selectedDeviceId,
    editorMode,
    activeTool,
    draftPoints,
    hoverWorld,
    keyCursor,
    worldToScreen,
    deviceRenderer,
    dropHover,
    dragPreview,
  ]);

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  // ── Hit testing ───────────────────────────────────────────────────

  const hitDevice = useCallback(
    (worldPt: number[]): EditorPlacement | null => {
      for (const d of devices) {
        if (distance([d.x ?? 0, d.y ?? 0], worldPt) <= HIT_RADIUS / scale + 8) return d;
      }
      return null;
    },
    [devices, scale],
  );

  const hitZone = useCallback(
    (worldPt: number[]): EditorZone | null => {
      for (const z of zones) {
        if (z.polygon && z.polygon.length >= 3 && pointInPolygon(worldPt, z.polygon)) return z;
      }
      return null;
    },
    [zones],
  );

  // ── Mouse handlers ────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** Panning is where three different gestures end up — the explicit alt/middle
   *  drag and, in two modes, a press that hit nothing. One function so the start
   *  point and the offset it will be measured against are always captured together. */
  const beginPan = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      setPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    },
    [offset],
  );

  /** The selected device, but only when it is a camera and the mode can rotate one
   *  — the precondition the rotate grab and its hover cursor have to agree on. */
  const rotatableSelection = useCallback((): EditorPlacement | null => {
    if (editorMode !== EDITOR_MODES.DEVICE_PLACE || !selectedDeviceId) return null;
    const sel = devices.find((d) => d.device_id === selectedDeviceId);
    if (!sel || (sel.device_type || "camera") !== "camera") return null;
    return sel;
  }, [editorMode, selectedDeviceId, devices]);

  // ── Mouse-down, one function per editor mode ──────────────────────
  // onMouseDown itself only decides which mode the press belongs to; each mode's
  // own reading of a press lives below it, because they share nothing but the point.

  /** ZONE_DRAW: a press either closes the polygon or adds a point to it. */
  const zoneDrawMouseDown = useCallback(
    (world: number[]) => {
      if (draftPoints.length >= 3 && distance(world, draftPoints[0]) * scale < 12) {
        onZoneCreate?.(draftPoints);
        setDraftPoints([]);
        return;
      }
      setDraftPoints((prev) => [...prev, world]);
    },
    [draftPoints, scale, onZoneCreate],
  );

  /** Starts a rotate drag if the press landed on a camera's grip — or anywhere in
   *  its cone, which is the far easier target. Answers whether it took the press. */
  const beginRotateDrag = useCallback(
    (world: number[]): boolean => {
      const sel = rotatableSelection();
      if (!sel) return false;
      const overHandle = distance(world, rotationHandleWorld(sel, scale)) * scale < 12;
      const overFov = isPointInDeviceFov(sel, world);
      if (!overHandle && !overFov) return false;
      setHoverRotationHandle(overHandle);
      setHoverRotationFov(overFov);
      setHoverDeviceId(sel.device_id ?? null);
      dragRef.current = {
        device: sel,
        mode: "rotate",
        origRotation: sel.rotation ?? 0,
        moved: false,
        changed: false,
      };
      return true;
    },
    [rotatableSelection, scale],
  );

  /** VIEW and ZONE_SELECT: a press selects whatever is under it, and empty plan
   *  drags the view — nothing here may start a device drag. */
  const selectMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>, world: number[]) => {
      const hd = hitDevice(world);
      if (hd) {
        onSelectDevice?.(hd);
        onDeviceClick?.(hd);
        return;
      }
      const hz = hitZone(world);
      if (hz) {
        onSelectZone?.(hz);
        return;
      }
      beginPan(e);
    },
    [hitDevice, hitZone, onSelectDevice, onDeviceClick, onSelectZone, beginPan],
  );

  /** DEVICE_PLACE: rotate, then move, then select a zone, then pan. The order is
   *  the point — the smallest target has to be tried first or it is unreachable. */
  const deviceEditMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>, world: number[]) => {
      if (beginRotateDrag(world)) return;
      const hd = hitDevice(world);
      if (hd) {
        setHoverDeviceId(hd.device_id ?? null);
        onSelectDevice?.(hd);
        dragRef.current = {
          device: hd,
          mode: "move",
          origWorld: [hd.x ?? 0, hd.y ?? 0],
          startWorld: world,
          moved: false,
          changed: false,
        };
        return;
      }
      const hz = hitZone(world);
      if (hz) {
        onSelectZone?.(hz);
        return;
      }
      beginPan(e);
    },
    [beginRotateDrag, hitDevice, hitZone, onSelectDevice, onSelectZone, beginPan],
  );

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      // Alt and the middle button pan from anywhere, whatever the mode is doing.
      if (e.button === 1 || e.altKey) {
        beginPan(e);
        return;
      }

      if (editorMode === EDITOR_MODES.ZONE_DRAW && activeTool === TOOL_TYPES.ZONE_POLYGON) {
        zoneDrawMouseDown(world);
        return;
      }

      if (
        editorMode === EDITOR_MODES.DEVICE_PLACE &&
        (activeTool === TOOL_TYPES.CAMERA_PLACE || activeTool === TOOL_TYPES.NVR_PLACE)
      ) {
        onDeviceCreate?.({ x: world[0], y: world[1] });
        return;
      }

      if (editorMode === EDITOR_MODES.DEVICE_PLACE) deviceEditMouseDown(e, world);
      else selectMouseDown(e, world);
    },
    [
      screenToWorld,
      editorMode,
      activeTool,
      onDeviceCreate,
      beginPan,
      zoneDrawMouseDown,
      deviceEditMouseDown,
      selectMouseDown,
    ],
  );

  // ── Mouse-move, one function per thing the pointer can be doing ───

  /** A move drag is confined to the zones: outside one the device simply stops
   *  following the pointer, which reads as a wall rather than as a dropped frame. */
  const dragDeviceTo = useCallback(
    (drag: MoveDrag, world: number[]) => {
      const nx = drag.origWorld[0] + (world[0] - drag.startWorld[0]);
      const ny = drag.origWorld[1] + (world[1] - drag.startWorld[1]);
      if (!pointInAnyZone([nx, ny], zones)) return;
      if (drag.device.x !== nx || drag.device.y !== ny) drag.changed = true;
      drag.device.x = nx;
      drag.device.y = ny;
    },
    [zones],
  );

  /** Rotation follows the pointer's bearing from the device. The +90° is what turns
   *  the canvas's east-is-zero into the device's north-is-zero. */
  const rotateDeviceTo = useCallback((drag: RotateDrag, world: number[]) => {
    const cx = drag.device.x ?? 0;
    const cy = drag.device.y ?? 0;
    const ang = (Math.atan2(world[1] - cy, world[0] - cx) + Math.PI / 2) * (180 / Math.PI);
    const nextRotation = ((ang % 360) + 360) % 360;
    if (drag.device.rotation !== nextRotation) drag.changed = true;
    drag.device.rotation = nextRotation;
  }, []);

  /** The grab cursor that promises a rotation is available, kept in step with the
   *  grab itself — and cleared wherever it is not, which is most of the time. */
  const updateRotationHover = useCallback(
    (world: number[]) => {
      const sel = rotatableSelection();
      if (!sel) {
        setHoverRotationHandle(false);
        setHoverRotationFov(false);
        return;
      }
      setHoverRotationHandle(distance(world, rotationHandleWorld(sel, scale)) * scale < 12);
      setHoverRotationFov(isPointInDeviceFov(sel, world));
    },
    [rotatableSelection, scale],
  );

  const onMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

      // A drag owns the pointer: while one is running nothing else on the canvas
      // may react to the move, not even the hover states.
      const drag = dragRef.current;
      if (drag) {
        drag.moved = true;
        if (drag.mode === "move") dragDeviceTo(drag, world);
        else rotateDeviceTo(drag, world);
        return;
      }

      setHoverDeviceId(hitDevice(world)?.device_id ?? null);

      if (panning && panStartRef.current) {
        setOffset({
          x: panStartRef.current.ox + (e.clientX - panStartRef.current.x),
          y: panStartRef.current.oy + (e.clientY - panStartRef.current.y),
        });
        return;
      }

      updateRotationHover(world);

      if (
        editorMode === EDITOR_MODES.ZONE_DRAW &&
        activeTool === TOOL_TYPES.ZONE_POLYGON &&
        draftPoints.length > 0
      ) {
        setHoverWorld(world);
      }
    },
    [
      panning,
      editorMode,
      activeTool,
      draftPoints,
      screenToWorld,
      hitDevice,
      dragDeviceTo,
      rotateDeviceTo,
      updateRotationHover,
    ],
  );

  const endDragOrPan = useCallback(() => {
    if (dragRef.current) {
      const drag = dragRef.current;
      if (drag.changed) {
        // `changed` is only ever set after x/y (or rotation) were assigned above,
        // so the fallbacks never fire; they satisfy the point's non-optional shape.
        if (drag.mode === "move") {
          onDeviceMove?.(drag.device, { x: drag.device.x ?? 0, y: drag.device.y ?? 0 });
        } else if (drag.mode === "rotate") {
          onDeviceRotate?.(drag.device, drag.device.rotation ?? 0);
        }
      } else if (drag.mode === "move") {
        onDeviceClick?.(drag.device);
      }
      dragRef.current = null;
    }
    setPanning(false);
    panStartRef.current = null;
    setHoverDeviceId(null);
    setHoverRotationHandle(false);
    setHoverRotationFov(false);
  }, [onDeviceMove, onDeviceRotate, onDeviceClick]);

  // dataTransfer.getData() is unreadable during dragover (protected mode), so the
  // payload can't be inspected here — only its presence via `types`. The device
  // itself arrives out-of-band as the `dragPreview` prop.
  const onDragOver = useCallback(
    (e: DragEvent<HTMLCanvasElement>) => {
      if (
        !e.dataTransfer.types.includes("application/x-neubit-device") &&
        !e.dataTransfer.types.includes("application/x-neubit-camera")
      )
        return;
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const zone = hitZone(world);
      e.dataTransfer.dropEffect = zone ? "copy" : "none";
      setDropHover({ world, zoneId: zone?.zone_id ?? null, valid: !!zone });
    },
    [screenToWorld, hitZone],
  );

  // Only clear when the pointer actually leaves the plan — a dragleave onto
  // anything else inside the container would flicker the ghost off.
  const onDragLeave = useCallback((e: DragEvent<HTMLCanvasElement>) => {
    if (e.relatedTarget && containerRef.current?.contains(e.relatedTarget as Node)) return;
    setDropHover(null);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent<HTMLCanvasElement>) => {
      const data =
        e.dataTransfer.getData("application/x-neubit-device") ||
        e.dataTransfer.getData("application/x-neubit-camera");
      if (!data) return;
      e.preventDefault();
      setDropHover(null);
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      // Devices must land in a zone. Say so rather than swallowing the drop.
      if (!pointInAnyZone(world, zones)) {
        onInvalidDrop?.();
        return;
      }
      let payload: DevicePayload | null;
      try {
        // The only writer of these mime types is our own PaletteRow, which
        // serialises a DevicePayload — so the parse is trusted to that shape.
        payload = JSON.parse(data) as DevicePayload;
      } catch {
        payload = null;
      }
      if (payload) {
        onDeviceDrop?.({ payload, point: { x: world[0], y: world[1] } });
      }
    },
    [screenToWorld, onDeviceDrop, onInvalidDrop, zones],
  );

  // ── Keyboard handlers ─────────────────────────────────────────────

  const drawing =
    editorMode === EDITOR_MODES.ZONE_DRAW && activeTool === TOOL_TYPES.ZONE_POLYGON;

  /** Where the crosshair starts when the arrows are first used: on the last point
   *  of a polygon already under way, otherwise the middle of the view. */
  const cursorOrigin = useCallback((): number[] => {
    const last = draftPoints.at(-1);
    if (last) return last;
    const el = containerRef.current;
    if (!el) return [0, 0];
    return screenToWorld(el.clientWidth / 2, el.clientHeight / 2);
  }, [draftPoints, screenToWorld]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const el = containerRef.current;
      if (!el) return;
      const action = canvasKeyAction(e.key, e, { drawing, draftCount: draftPoints.length });
      if (!action) return;
      e.preventDefault();
      const cw = el.clientWidth;
      const ch = el.clientHeight;

      switch (action.kind) {
        case "pan":
          setOffset((prev) => ({ x: prev.x + action.dx, y: prev.y + action.dy }));
          return;
        case "zoom":
          zoomAt(cw / 2, ch / 2, action.factor);
          return;
        case "fit":
          fitToContainer();
          return;
        case "cursor": {
          const base = keyCursor ?? cursorOrigin();
          const [sx, sy] = worldToScreen(base[0], base[1]);
          // Clamped to the viewport: a crosshair walked off screen is a cursor the
          // operator cannot see, and a point they cannot aim.
          const next = screenToWorld(
            Math.max(0, Math.min(cw, sx + action.dx)),
            Math.max(0, Math.min(ch, sy + action.dy)),
          );
          setKeyCursor(next);
          // Feeds the rubber-band line, exactly as the mouse's hover does.
          setHoverWorld(next);
          return;
        }
        case "addPoint": {
          const pt = keyCursor ?? cursorOrigin();
          setKeyCursor(pt);
          // Landing back on the first point closes the polygon — the same gesture
          // the mouse has, so both paths finish a zone the same way.
          if (draftPoints.length >= 3 && distance(pt, draftPoints[0]) * scale < 12) {
            onZoneCreate?.(draftPoints);
            setDraftPoints([]);
            return;
          }
          setDraftPoints((prev) => [...prev, pt]);
          return;
        }
        case "undoPoint":
          setDraftPoints((prev) => prev.slice(0, -1));
          return;
      }
    },
    [
      drawing,
      draftPoints,
      keyCursor,
      cursorOrigin,
      screenToWorld,
      worldToScreen,
      zoomAt,
      fitToContainer,
      onZoneCreate,
      scale,
    ],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDraftPoints([]);
      if (e.key === "Enter" && draftPoints.length >= 3) {
        onZoneCreate?.(draftPoints);
        setDraftPoints([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftPoints, onZoneCreate]);

  const cursor = useMemo(() => {
    if (editorMode === EDITOR_MODES.VIEW) return "default";
    if (dragRef.current?.mode === "rotate") return "grabbing";
    if (hoverRotationHandle || hoverRotationFov) return "grab";
    if (hoverDeviceId) return "move";
    if (panning) return "grabbing";
    if (editorMode === EDITOR_MODES.ZONE_DRAW && activeTool === TOOL_TYPES.ZONE_POLYGON)
      return "crosshair";
    if (editorMode === EDITOR_MODES.DEVICE_PLACE) return "default";
    return "grab";
  }, [panning, editorMode, activeTool, hoverRotationHandle, hoverRotationFov, hoverDeviceId]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-xl border border-card-border bg-hover/40"
      style={{ cursor }}
    >
      {/* Pointer and keyboard both belong on the canvas, not on the wrapper: it is
          the surface being drawn on, and the wrapper only positions it. Focusable
          because pan, zoom and placing a polygon point all happen in one coordinate
          space with nothing smaller to tab to — the keys below are a real path to
          each of them, and Tab is left unclaimed so focus can always leave again. */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="Floor plan. Arrow keys pan the view, plus and minus zoom, 0 fits the plan. While drawing a zone the arrows move a crosshair, Space adds a point, Backspace removes the last, Enter closes the zone and Escape cancels it."
        className="block h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDragOrPan}
        onMouseLeave={endDragOrPan}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        A floor plan with {zones.length} zone{zones.length === 1 ? "" : "s"} drawn on
        it. Zones can be listed, selected and edited from the zone list beside this
        plan.
      </canvas>
      {dropHover && (
        <div
          className={`pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs font-medium shadow-xs ${
            dropHover.valid
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
              : "border-red-500/40 bg-red-500/10 text-red-600"
          }`}
        >
          {dropHover.valid
            ? `Drop ${dragPreview?.name ?? "device"} in ${
                zones.find((z) => z.zone_id === dropHover.zoneId)?.name ?? "this zone"
              }`
            : "Devices must be dropped inside a zone"}
        </div>
      )}
      {!floorplanUrl && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-card/90 px-3 py-1.5 text-xs text-muted shadow-sm border border-card-border">
          Upload a floor plan to begin
        </div>
      )}
    </div>
  );
});
