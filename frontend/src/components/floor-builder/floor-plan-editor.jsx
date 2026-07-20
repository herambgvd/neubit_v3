"use client";

// Floor-plan editor — ported from neubit_v2, adapted to neubit_v3.
//
// Zones: floorplan display, zone-polygon drawing/editing, zone sidebar, save
// (create/update/delete zones), undo/redo, upload/replace floorplan.
//
// Devices: drag a device from the palette onto the canvas (must land inside a zone),
// move it (its zone is recomputed via point-in-polygon), rotate cameras (FoV arc),
// select/delete, and persist via the save loop (draft→register, changed→update,
// deleted→remove, then refetch by-floor). Device inventory for the palette comes from
// the access-control service (controllers + doors) — see DeviceManagementSidebar.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { CanvasToolControls } from "@/components/floor-builder/canvas-tool-controls";
import { EDITOR_MODES, TOOL_TYPES } from "@/components/floor-builder/constants";
import { DeviceManagementSidebar } from "@/components/floor-builder/DeviceManagementSidebar";
import { drawCameraPlacement } from "@/components/floor-builder/cameraRenderer";
import { FloorPlanCanvas } from "@/components/floor-builder/floor-plan-canvas";
import { FloorPlanToolbar } from "@/components/floor-builder/floor-plan-toolbar";
import { FloorUploadModal } from "@/components/floor-builder/floor-upload-modal";
import { useDeviceInventory } from "@/components/floor-builder/useDeviceInventory";
import { ZoneManagementSidebar } from "@/components/floor-builder/zone-management-sidebar";
import { apiError } from "@/lib/api";
import { sites } from "@/lib/api/sites";

const HISTORY_LIMIT = 30;

function buildZonePayload(zone) {
  return {
    name: zone.name,
    description: zone.description ?? null,
    zone_type: zone.zone_type,
    threat_level: zone.threat_level,
    color: zone.color,
    alert_on_entry: !!zone.alert_on_entry,
    alert_on_exit: !!zone.alert_on_exit,
    max_occupancy:
      zone.max_occupancy === "" || zone.max_occupancy == null ? null : Number(zone.max_occupancy),
    polygon: zone.polygon,
  };
}

// Flatten nested floor_position into top-level x/y/rotation so the canvas can read
// them directly (the canvas draws from `device.x/y/rotation`).
function normalizePlacement(p) {
  return {
    ...p,
    x: p.floor_position?.x ?? p.x ?? 0,
    y: p.floor_position?.y ?? p.y ?? 0,
    rotation: p.floor_position?.rotation ?? p.rotation ?? 0,
  };
}

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

function isInsideAnyZone(point, zones = []) {
  if (!zones.length) return false;
  return zones.some(
    (z) =>
      Array.isArray(z.polygon) &&
      z.polygon.length >= 3 &&
      pointInPolygon([point.x, point.y], z.polygon),
  );
}

function getZoneIdForPoint(point, zones = []) {
  const zone = zones.find(
    (z) =>
      Array.isArray(z.polygon) &&
      z.polygon.length >= 3 &&
      pointInPolygon([point.x, point.y], z.polygon),
  );
  return zone?.zone_id ?? null;
}

export function FloorPlanEditor({ floor: initialFloor, onClose, onSaved }) {
  const canvasRef = useRef(null);
  const [floor, setFloor] = useState(initialFloor);
  const [zones, setZones] = useState([]);
  const [placements, setPlacements] = useState([]);
  const [editorMode, setEditorMode] = useState(EDITOR_MODES.VIEW);
  const [activeTool, setActiveTool] = useState(TOOL_TYPES.SELECT);
  const [scale, setScale] = useState(1);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const [history, setHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [unsaved, setUnsaved] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const savedPlacementsRef = useRef([]);
  const [deletedDeviceIds, setDeletedDeviceIds] = useState(() => new Set());

  // ── Sync `floor` when parent passes a different one (render-phase reset) ──
  const lastFloorIdRef = useRef(initialFloor?.floor_id);
  if (lastFloorIdRef.current !== initialFloor?.floor_id) {
    lastFloorIdRef.current = initialFloor?.floor_id;
    setFloor(initialFloor);
  }

  // Placement records are id-only (the backend stores no device name), so resolve the
  // label from the inventory. `p.name` only survives for a device dropped this session;
  // after a save+reload the join is the sole source of a real name.
  const { inventoryById } = useDeviceInventory();
  const displayPlacements = useMemo(
    () =>
      placements.map((p) => ({
        ...p,
        name: inventoryById.get(p.device_id)?.name || p.name || p.label || p.device_id,
      })),
    [placements, inventoryById],
  );

  // ── Load zones + placements when floor changes ─────────────────────
  useEffect(() => {
    if (!floor?.floor_id) return;
    let cancelled = false;
    (async () => {
      try {
        const [zoneRes, placementRes] = await Promise.all([
          sites.zones.list({ floor_id: floor.floor_id, limit: 100 }),
          sites.devicePlacements.listByFloor(floor.floor_id).catch(() => ({ items: [] })),
        ]);
        if (!cancelled) {
          const nextPlacements = (placementRes?.items ?? [])
            .map(normalizePlacement)
            .map((p) => ({ ...p, is_draft: false }));
          setZones(zoneRes?.items ?? []);
          setPlacements(nextPlacements);
          savedPlacementsRef.current = nextPlacements;
          setDeletedDeviceIds(new Set());
          setHistory([]);
          setRedoStack([]);
          setUnsaved(false);
        }
      } catch (err) {
        if (!cancelled) toast.error(apiError(err, "Failed to load floor data"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [floor?.floor_id]);

  // ── History ────────────────────────────────────────────────────────
  const pushHistory = useCallback((prevZones) => {
    setHistory((h) => [...h.slice(-HISTORY_LIMIT + 1), prevZones]);
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const next = [...h];
      const prev = next.pop();
      setRedoStack((r) => [zones, ...r].slice(0, HISTORY_LIMIT));
      setZones(prev);
      setUnsaved(true);
      return next;
    });
  }, [zones]);

  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (r.length === 0) return r;
      const [next, ...rest] = r;
      setHistory((h) => [...h.slice(-HISTORY_LIMIT + 1), zones]);
      setZones(next);
      setUnsaved(true);
      return rest;
    });
  }, [zones]);

  // ── Zone mutations ─────────────────────────────────────────────────
  const onZoneCreate = useCallback(
    (points) => {
      pushHistory(zones);
      const draft = {
        zone_id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: `Zone ${zones.length + 1}`,
        polygon: points,
        zone_type: "other",
        threat_level: "normal",
        color: "#2563eb",
        max_occupancy: null,
        alert_on_entry: false,
        alert_on_exit: false,
        is_draft: true,
      };
      setZones((z) => [...z, draft]);
      setSelectedZoneId(draft.zone_id);
      setUnsaved(true);
      toast.success("Zone added — adjust properties on the right");
    },
    [zones, pushHistory],
  );

  const onZoneUpdate = useCallback(
    async (zone, patch) => {
      const nextZone = { ...zone, ...patch };

      // Draft (unsaved) zones are edited locally; they persist on Save.
      if (zone.is_draft) {
        pushHistory(zones);
        setZones((arr) => arr.map((z) => (z.zone_id === zone.zone_id ? nextZone : z)));
        setUnsaved(true);
        return;
      }

      setZones((arr) => arr.map((z) => (z.zone_id === zone.zone_id ? nextZone : z)));

      try {
        const savedZone = await sites.zones.update(zone.zone_id, buildZonePayload(nextZone));
        setZones((arr) => arr.map((z) => (z.zone_id === zone.zone_id ? savedZone : z)));
        toast.success("Zone updated");
      } catch (err) {
        setZones((arr) => arr.map((z) => (z.zone_id === zone.zone_id ? zone : z)));
        toast.error(apiError(err, "Zone update failed"));
        throw err;
      }
    },
    [zones, pushHistory],
  );

  const onZoneDelete = useCallback(
    (zone) => {
      pushHistory(zones);
      setZones((arr) => arr.filter((z) => z.zone_id !== zone.zone_id));
      if (selectedZoneId === zone.zone_id) setSelectedZoneId(null);
      setUnsaved(true);
    },
    [zones, selectedZoneId, pushHistory],
  );

  // ── Save (zones + device placements) ───────────────────────────────
  const save = useCallback(async () => {
    if (!floor?.floor_id) return;
    setSaving(true);
    try {
      const updated = [];
      // Map draft (client-side) zone ids → real persisted ids, so device placements
      // dropped into a freshly-drawn zone reference a valid zone.
      const draftToReal = new Map();
      for (const zone of zones) {
        const payload = buildZonePayload(zone);
        if (zone.is_draft) {
          const created = await sites.zones.create({
            ...payload,
            site_id: floor.site_id,
            floor_id: floor.floor_id,
          });
          if (created?.zone_id) draftToReal.set(zone.zone_id, created.zone_id);
          updated.push(created);
        } else {
          const u = await sites.zones.update(zone.zone_id, payload);
          updated.push(u);
        }
      }
      // Delete zones removed locally (persisted server-side but not in current state).
      const keptIds = new Set(updated.map((z) => z.zone_id));
      const fresh = await sites.zones.list({ floor_id: floor.floor_id, limit: 100 });
      for (const remote of fresh?.items ?? []) {
        if (!keptIds.has(remote.zone_id)) {
          await sites.zones.remove(remote.zone_id);
        }
      }

      // ── Device placements ──────────────────────────────────────────
      const savedById = new Map(savedPlacementsRef.current.map((p) => [p.device_id, p]));

      // Remove placements deleted this session (only if they were ever persisted).
      for (const deletedId of deletedDeviceIds) {
        const wasSaved = savedById.get(deletedId);
        if (wasSaved && !wasSaved.is_draft) {
          await sites.devicePlacements.remove(deletedId);
        }
      }

      for (const placement of placements) {
        if (deletedDeviceIds.has(placement.device_id)) continue;

        const persisted = savedById.get(placement.device_id);
        const rawZoneId = placement.zone_id || getZoneIdForPoint(placement, zones);
        // Remap any draft zone id to its persisted id (drawn-then-placed zones).
        const zone_id = (rawZoneId && draftToReal.get(rawZoneId)) || rawZoneId;
        const floor_position = {
          x: placement.x ?? placement.floor_position?.x ?? 0,
          y: placement.y ?? placement.floor_position?.y ?? 0,
          rotation: placement.rotation ?? placement.floor_position?.rotation ?? 0,
        };
        const metadata = placement.metadata ?? null;
        const needsCreate = placement.is_draft || !persisted;
        const needsUpdate =
          persisted &&
          (persisted.x !== placement.x ||
            persisted.y !== placement.y ||
            persisted.rotation !== placement.rotation ||
            persisted.zone_id !== zone_id ||
            persisted.device_type !== placement.device_type ||
            persisted.service !== placement.service);

        if (needsCreate) {
          await sites.devicePlacements.register({
            device_id: placement.device_id,
            device_type: placement.device_type,
            service: placement.service,
            site_id: floor.site_id,
            floor_id: floor.floor_id,
            zone_id,
            floor_position,
            metadata,
          });
        } else if (needsUpdate) {
          await sites.devicePlacements.update(placement.device_id, {
            zone_id,
            floor_position,
            metadata,
          });
        }
      }

      // Refetch persisted placements as the new baseline.
      const refreshed = await sites.devicePlacements.listByFloor(floor.floor_id);
      const syncedPlacements = (refreshed?.items ?? [])
        .map(normalizePlacement)
        .map((p) => ({ ...p, is_draft: false }));

      setPlacements(syncedPlacements);
      savedPlacementsRef.current = syncedPlacements;
      setDeletedDeviceIds(new Set());
      setZones(updated);
      setUnsaved(false);
      setLastSavedAt(new Date().toISOString());
      onSaved?.(floor);
      toast.success("Floor plan saved");
    } catch (err) {
      toast.error(apiError(err, "Save failed"));
    } finally {
      setSaving(false);
    }
  }, [floor, zones, placements, deletedDeviceIds, onSaved]);

  // ── Mode/tool sync (render-phase) ──────────────────────────────────
  const lastModeRef = useRef(editorMode);
  if (lastModeRef.current !== editorMode) {
    lastModeRef.current = editorMode;
    if (editorMode === EDITOR_MODES.ZONE_DRAW) setActiveTool(TOOL_TYPES.ZONE_POLYGON);
    else setActiveTool(TOOL_TYPES.SELECT);
  }

  // ── Device placement handlers ──────────────────────────────────────
  const onDevicePaletteDrop = useCallback(
    ({ payload, point }) => {
      const deviceId = payload?.device_id;
      if (!floor?.floor_id || !deviceId) return;
      if (!isInsideAnyZone(point, zones)) {
        toast.error("Device can only be placed inside a zone boundary");
        return;
      }
      const zone_id = getZoneIdForPoint(point, zones);
      setPlacements((p) => [
        ...p,
        {
          device_id: deviceId,
          device_type: payload.device_type || "other",
          service: payload.service || "access_control",
          site_id: floor.site_id,
          floor_id: floor.floor_id,
          zone_id,
          floor_position: { x: point.x, y: point.y, rotation: 0 },
          x: point.x,
          y: point.y,
          rotation: 0,
          metadata: payload.metadata ?? null,
          name: payload.name || deviceId,
          is_draft: true,
        },
      ]);
      setDeletedDeviceIds((prev) => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
      setSelectedDeviceId(deviceId);
      setUnsaved(true);
      toast.success(`Placed ${payload.name || deviceId} on the floor`);
    },
    [floor, zones],
  );

  const onDeviceMove = useCallback(
    (device, { x, y }) => {
      if (!isInsideAnyZone({ x, y }, zones)) {
        toast.error("Device must remain inside a zone boundary");
        return;
      }
      const zone_id = getZoneIdForPoint({ x, y }, zones);
      setPlacements((arr) =>
        arr.map((p) =>
          p.device_id === device.device_id
            ? {
                ...p,
                x,
                y,
                zone_id,
                floor_position: {
                  x,
                  y,
                  rotation: p.rotation ?? p.floor_position?.rotation ?? 0,
                },
              }
            : p,
        ),
      );
      setUnsaved(true);
    },
    [zones],
  );

  const onDeviceRotate = useCallback(
    (device, rotation) => {
      if ((device.device_type || "camera") !== "camera") return;
      if (editorMode === EDITOR_MODES.VIEW) return;
      setPlacements((arr) =>
        arr.map((p) =>
          p.device_id === device.device_id
            ? {
                ...p,
                rotation,
                floor_position: {
                  x: p.x ?? p.floor_position?.x ?? 0,
                  y: p.y ?? p.floor_position?.y ?? 0,
                  rotation,
                },
              }
            : p,
        ),
      );
      setUnsaved(true);
    },
    [editorMode],
  );

  const onDeviceDelete = useCallback((device) => {
    setPlacements((arr) => arr.filter((p) => p.device_id !== device.device_id));
    setDeletedDeviceIds((prev) => {
      const next = new Set(prev);
      next.add(device.device_id);
      return next;
    });
    setSelectedDeviceId(null);
    setUnsaved(true);
    toast.success(`Removed ${device.name || device.label || device.device_id} from floor`);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (unsaved) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, save, unsaved]);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted">Floor plan editor</div>
          <div className="truncate text-base font-semibold text-foreground">{floor?.name}</div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            icon="heroicons-outline:cloud-arrow-up"
            onClick={() => setUploadOpen(true)}
          >
            {floor?.floorplan_url ? "Replace floor plan" : "Upload floor plan"}
          </Button>
          {onClose && (
            <Button variant="ghost" icon="heroicons-outline:x-mark" onClick={onClose}>
              Close
            </Button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <FloorPlanToolbar
        editorMode={editorMode}
        onModeChange={setEditorMode}
        zoneCount={zones.length}
        deviceCount={placements.length}
        unsavedChanges={unsaved}
        lastSavedAt={lastSavedAt}
        canUndo={history.length > 0}
        canRedo={redoStack.length > 0}
        onUndo={undo}
        onRedo={redo}
        onSave={save}
      />

      {/* Workspace */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="relative min-w-0 flex-1">
          {floor?.floorplan_url ? null : (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-card-border bg-card/90 px-3 py-1.5 text-xs text-muted shadow">
              <Icon icon="heroicons-outline:photo" className="mr-1 inline text-sm" />
              No floor plan uploaded yet
            </div>
          )}
          {editorMode === EDITOR_MODES.DEVICE_PLACE && (
            <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-card-border bg-card/90 px-3 py-1.5 text-xs text-muted shadow">
              <Icon icon="heroicons-outline:cursor-arrow-rays" className="mr-1 inline text-sm" />
              Drag a device from the right onto a zone. Drag to move; drag a selected
              camera&apos;s cone to rotate.
            </div>
          )}
          <FloorPlanCanvas
            ref={canvasRef}
            floor={floor}
            floorplanUrl={floor?.floorplan_url}
            zones={zones}
            devices={displayPlacements}
            editorMode={editorMode}
            activeTool={activeTool}
            selectedZoneId={selectedZoneId}
            selectedDeviceId={selectedDeviceId}
            onSelectZone={(z) => {
              setSelectedZoneId(z.zone_id);
              setSelectedDeviceId(null);
            }}
            onSelectDevice={(d) => {
              setSelectedDeviceId(d.device_id);
              setSelectedZoneId(null);
            }}
            onZoneCreate={onZoneCreate}
            onZoneUpdate={onZoneUpdate}
            onDeviceDrop={onDevicePaletteDrop}
            onDeviceMove={onDeviceMove}
            onDeviceRotate={onDeviceRotate}
            deviceRenderer={drawCameraPlacement}
          />
          {editorMode === EDITOR_MODES.ZONE_DRAW && (
            <CanvasToolControls
              activeTool={activeTool}
              onToolSelect={setActiveTool}
              canvasScale={scale}
              onScaleChange={(s) => {
                setScale(s);
                canvasRef.current?.setScale?.(s);
              }}
            />
          )}
        </div>

        {editorMode === EDITOR_MODES.DEVICE_PLACE ? (
          <DeviceManagementSidebar
            placements={displayPlacements}
            selectedDeviceId={selectedDeviceId}
            onSelectDevice={(p) => setSelectedDeviceId(p.device_id)}
            onDeleteDevice={onDeviceDelete}
          />
        ) : (
          <ZoneManagementSidebar
            zones={zones}
            selectedZoneId={selectedZoneId}
            onSelectZone={(z) => setSelectedZoneId(z.zone_id)}
            onZoneUpdate={onZoneUpdate}
            onZoneDelete={onZoneDelete}
            onStartDrawing={() => {
              setEditorMode(EDITOR_MODES.ZONE_DRAW);
              setActiveTool(TOOL_TYPES.ZONE_POLYGON);
              toast.info("Click on the canvas to add polygon points; press Enter to finish");
            }}
          />
        )}
      </div>

      <FloorUploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        floor={floor}
        onUploaded={(updated) => setFloor(updated)}
      />
    </div>
  );
}

// Full-screen modal launcher used from the Sites config page.
export function FloorPlanEditorModal({ open, onClose, floor, onSaved }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="h-full overflow-hidden p-4">
        <FloorPlanEditor floor={floor} onClose={onClose} onSaved={onSaved} />
      </div>
    </div>
  );
}
