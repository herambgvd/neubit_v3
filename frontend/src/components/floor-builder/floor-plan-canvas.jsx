"use client";

// Floor-plan canvas — ported from neubit_v2. Renders the floorplan image and lets
// the operator draw zone polygons (click to add points, click-near-start or Enter to
// close, Esc to cancel). Pan (alt/middle-drag or empty-drag) + wheel-zoom.
//
// Device-placement paths (drag-drop / move / rotate / FoV) are retained but DORMANT:
// neubit_v3 has no devices backend yet, so `devices` is always [] and the parent editor
// never enters DEVICE_PLACE mode. The device code stays so re-enabling is a one-liner in
// the devices phase.
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fileUrl } from "@/lib/api";
import { EDITOR_MODES, TOOL_TYPES } from "@/components/floor-builder/constants";

const HIT_RADIUS = 8; // px in screen space

// ── Geometry helpers ──────────────────────────────────────────────────

function pointInPolygon(pt, points) {
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

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function normalizeAngleRad(a) {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function isPointInDeviceFov(device, worldPt) {
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

function pointInAnyZone(worldPt, zones = []) {
  if (!zones.length) return false;
  return zones.some(
    (z) => z.polygon && z.polygon.length >= 3 && pointInPolygon(worldPt, z.polygon),
  );
}

// ── Component ─────────────────────────────────────────────────────────

export const FloorPlanCanvas = forwardRef(function FloorPlanCanvas(
  {
    floor,
    floorplanUrl,
    zones = [],
    devices = [],
    editorMode = EDITOR_MODES.VIEW,
    activeTool = TOOL_TYPES.SELECT,
    selectedZoneId = null,
    selectedDeviceId = null,
    onSelectZone,
    onSelectDevice,
    onZoneCreate, // (points: [[x,y],...]) => void
    onZoneUpdate, // (zoneId, { polygon }) => void
    onDeviceCreate, // (worldPt) => void
    onDeviceDrop, // ({ payload, point }) => void  — palette drag-drop
    onDeviceMove, // (device, { x, y }) => void
    onDeviceRotate, // (device, rotation) => void
    onDeviceClick, // (device) => void  — single click without drag
    deviceRenderer, // optional — ({ ctx, device, isSelected, scale, worldToScreen }) => void
  },
  ref,
) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [imgEl, setImgEl] = useState(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

  // View transform: translate (px) + scale.
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef(null);

  // Drawing state — points in WORLD coords (image-space pixels).
  const [draftPoints, setDraftPoints] = useState([]);
  const [hoverWorld, setHoverWorld] = useState(null);

  // Device drag state
  const dragRef = useRef(null); // { device, mode: "move"|"rotate", origWorld, origRotation, moved, changed }
  const [hoverRotationHandle, setHoverRotationHandle] = useState(false);
  const [hoverRotationFov, setHoverRotationFov] = useState(false);
  const [hoverDeviceId, setHoverDeviceId] = useState(null);

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
    img.src = fileUrl(floorplanUrl);
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
    (sx, sy) => [(sx - offset.x) / scale, (sy - offset.y) / scale],
    [offset, scale],
  );
  const worldToScreen = useCallback(
    (wx, wy) => [wx * scale + offset.x, wy * scale + offset.y],
    [offset, scale],
  );

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
      ctx.fillStyle = (zone.color || "#2563eb") + "33";
      ctx.fill();
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.strokeStyle = zone.color || "#2563eb";
      ctx.stroke();

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
    worldToScreen,
    deviceRenderer,
  ]);

  useEffect(() => {
    let frame;
    const loop = () => {
      draw();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [draw]);

  // ── Hit testing ───────────────────────────────────────────────────

  const hitDevice = useCallback(
    (worldPt) => {
      for (const d of devices) {
        if (distance([d.x ?? 0, d.y ?? 0], worldPt) <= HIT_RADIUS / scale + 8) return d;
      }
      return null;
    },
    [devices, scale],
  );

  const hitZone = useCallback(
    (worldPt) => {
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
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((prevScale) => {
        const next = Math.max(0.1, Math.min(5, prevScale * factor));
        setOffset((prevOff) => {
          const wx = (mx - prevOff.x) / prevScale;
          const wy = (my - prevOff.y) / prevScale;
          return { x: mx - wx * next, y: my - wy * next };
        });
        return next;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onMouseDown = useCallback(
    (e) => {
      const rect = containerRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);
      const canEditDevices = editorMode === EDITOR_MODES.DEVICE_PLACE;

      if (e.button === 1 || e.altKey) {
        setPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        return;
      }

      if (editorMode === EDITOR_MODES.ZONE_DRAW && activeTool === TOOL_TYPES.ZONE_POLYGON) {
        if (draftPoints.length >= 3 && distance(world, draftPoints[0]) * scale < 12) {
          onZoneCreate?.(draftPoints);
          setDraftPoints([]);
          return;
        }
        setDraftPoints((prev) => [...prev, world]);
        return;
      }

      if (
        editorMode === EDITOR_MODES.DEVICE_PLACE &&
        (activeTool === TOOL_TYPES.CAMERA_PLACE || activeTool === TOOL_TYPES.NVR_PLACE)
      ) {
        onDeviceCreate?.({ x: world[0], y: world[1] });
        return;
      }

      const hd = hitDevice(world);
      if (!canEditDevices) {
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
        setPanning(true);
        panStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        return;
      }

      if (selectedDeviceId) {
        const sel = devices.find((d) => d.device_id === selectedDeviceId);
        if (sel && (sel.device_type || "camera") === "camera") {
          const rot = (sel.rotation ?? 0) * (Math.PI / 180);
          const handleR = 28 / scale;
          const hx = (sel.x ?? 0) + Math.cos(rot - Math.PI / 2) * handleR;
          const hy = (sel.y ?? 0) + Math.sin(rot - Math.PI / 2) * handleR;
          const overHandle = distance(world, [hx, hy]) * scale < 12;
          const overFov = isPointInDeviceFov(sel, world);
          if (overHandle || overFov) {
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
            return;
          }
        }
      }

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
      setPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    },
    [
      offset,
      screenToWorld,
      editorMode,
      activeTool,
      draftPoints,
      scale,
      onZoneCreate,
      onDeviceCreate,
      hitDevice,
      hitZone,
      onSelectDevice,
      onSelectZone,
      onDeviceClick,
      selectedDeviceId,
      devices,
    ],
  );

  const onMouseMove = useCallback(
    (e) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy);

      if (dragRef.current) {
        const drag = dragRef.current;
        drag.moved = true;
        if (drag.mode === "move") {
          const dx = world[0] - drag.startWorld[0];
          const dy = world[1] - drag.startWorld[1];
          const nx = drag.origWorld[0] + dx;
          const ny = drag.origWorld[1] + dy;
          if (pointInAnyZone([nx, ny], zones)) {
            if (drag.device.x !== nx || drag.device.y !== ny) drag.changed = true;
            drag.device.x = nx;
            drag.device.y = ny;
          }
        } else if (drag.mode === "rotate") {
          const cx = drag.device.x ?? 0;
          const cy = drag.device.y ?? 0;
          const ang = (Math.atan2(world[1] - cy, world[0] - cx) + Math.PI / 2) * (180 / Math.PI);
          const nextRotation = ((ang % 360) + 360) % 360;
          if (drag.device.rotation !== nextRotation) drag.changed = true;
          drag.device.rotation = nextRotation;
        }
        return;
      }

      const hoveredDevice = hitDevice(world);
      setHoverDeviceId(hoveredDevice?.device_id ?? null);

      if (panning && panStartRef.current) {
        setOffset({
          x: panStartRef.current.ox + (e.clientX - panStartRef.current.x),
          y: panStartRef.current.oy + (e.clientY - panStartRef.current.y),
        });
        return;
      }

      if (selectedDeviceId && editorMode === EDITOR_MODES.DEVICE_PLACE) {
        const sel = devices.find((d) => d.device_id === selectedDeviceId);
        if (sel && (sel.device_type || "camera") === "camera") {
          const rot = (sel.rotation ?? 0) * (Math.PI / 180);
          const handleR = 28 / scale;
          const hx = (sel.x ?? 0) + Math.cos(rot - Math.PI / 2) * handleR;
          const hy = (sel.y ?? 0) + Math.sin(rot - Math.PI / 2) * handleR;
          const dist = distance(world, [hx, hy]) * scale;
          setHoverRotationHandle(dist < 12);
          setHoverRotationFov(isPointInDeviceFov(sel, world));
        } else {
          setHoverRotationHandle(false);
          setHoverRotationFov(false);
        }
      } else {
        setHoverRotationHandle(false);
        setHoverRotationFov(false);
      }

      if (
        editorMode === EDITOR_MODES.ZONE_DRAW &&
        activeTool === TOOL_TYPES.ZONE_POLYGON &&
        draftPoints.length > 0
      ) {
        setHoverWorld(world);
      }
    },
    [panning, editorMode, activeTool, draftPoints, screenToWorld, selectedDeviceId, devices, zones, scale, hitDevice],
  );

  const endDragOrPan = useCallback(() => {
    if (dragRef.current) {
      const drag = dragRef.current;
      if (drag.changed) {
        if (drag.mode === "move") {
          onDeviceMove?.(drag.device, { x: drag.device.x, y: drag.device.y });
        } else if (drag.mode === "rotate") {
          onDeviceRotate?.(drag.device, drag.device.rotation);
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

  const onDragOver = useCallback((e) => {
    if (
      e.dataTransfer.types.includes("application/x-neubit-device") ||
      e.dataTransfer.types.includes("application/x-neubit-camera")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onDrop = useCallback(
    (e) => {
      const data =
        e.dataTransfer.getData("application/x-neubit-device") ||
        e.dataTransfer.getData("application/x-neubit-camera");
      if (!data) return;
      e.preventDefault();
      const rect = containerRef.current.getBoundingClientRect();
      const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      if (!pointInAnyZone(world, zones)) return;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        payload = null;
      }
      if (payload) {
        onDeviceDrop?.({ payload, point: { x: world[0], y: world[1] } });
      }
    },
    [screenToWorld, onDeviceDrop, zones],
  );

  useEffect(() => {
    const onKey = (e) => {
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
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDragOrPan}
      onMouseLeave={endDragOrPan}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {!floorplanUrl && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-card/90 px-3 py-1.5 text-xs text-muted shadow border border-card-border">
          Upload a floor plan to begin
        </div>
      )}
    </div>
  );
});
