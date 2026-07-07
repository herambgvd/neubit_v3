"use client";

// Floor-plan editor — ported from neubit_v2, adapted to neubit_v3.
//
// WHAT'S KEPT: floorplan display, zone-polygon drawing/editing, zone sidebar, save
// (create/update/delete zones), undo/redo, upload/replace floorplan.
//
// WHAT'S DEFERRED (device placement): neubit_v3 has no devices/NVR/access/fire backend
// yet, so all device-inventory queries, drag-drop placement, and the DeviceManagementSidebar
// are removed. The editor never enters DEVICE_PLACE mode (that toolbar button is disabled).
// The canvas still carries the (dormant) device-draw/drag code so re-enabling is contained:
// when the devices phase lands, restore the inventory queries + placement save loop from
// neubit_v2's floor-plan-editor.jsx and mount DeviceManagementSidebar here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { CanvasToolControls } from "@/components/floor-builder/canvas-tool-controls";
import { EDITOR_MODES, TOOL_TYPES } from "@/components/floor-builder/constants";
import { FloorPlanCanvas } from "@/components/floor-builder/floor-plan-canvas";
import { FloorPlanToolbar } from "@/components/floor-builder/floor-plan-toolbar";
import { FloorUploadModal } from "@/components/floor-builder/floor-upload-modal";
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

export function FloorPlanEditor({ floor: initialFloor, onClose, onSaved }) {
  const canvasRef = useRef(null);
  const [floor, setFloor] = useState(initialFloor);
  const [zones, setZones] = useState([]);
  const [editorMode, setEditorMode] = useState(EDITOR_MODES.VIEW);
  const [activeTool, setActiveTool] = useState(TOOL_TYPES.SELECT);
  const [scale, setScale] = useState(1);
  const [selectedZoneId, setSelectedZoneId] = useState(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const [history, setHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [unsaved, setUnsaved] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);

  // ── Sync `floor` when parent passes a different one (render-phase reset) ──
  const lastFloorIdRef = useRef(initialFloor?.floor_id);
  if (lastFloorIdRef.current !== initialFloor?.floor_id) {
    lastFloorIdRef.current = initialFloor?.floor_id;
    setFloor(initialFloor);
  }

  // ── Load zones when floor changes ─────────────────────────────────
  useEffect(() => {
    if (!floor?.floor_id) return;
    let cancelled = false;
    (async () => {
      try {
        const zoneRes = await sites.zones.list({ floor_id: floor.floor_id, limit: 100 });
        if (!cancelled) {
          setZones(zoneRes?.items ?? []);
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

  // ── Save (zones only) ──────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!floor?.floor_id) return;
    setSaving(true);
    try {
      const updated = [];
      for (const zone of zones) {
        const payload = buildZonePayload(zone);
        if (zone.is_draft) {
          const created = await sites.zones.create({
            ...payload,
            site_id: floor.site_id,
            floor_id: floor.floor_id,
          });
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
  }, [floor, zones, onSaved]);

  // ── Mode/tool sync (render-phase) ──────────────────────────────────
  const lastModeRef = useRef(editorMode);
  if (lastModeRef.current !== editorMode) {
    lastModeRef.current = editorMode;
    if (editorMode === EDITOR_MODES.ZONE_DRAW) setActiveTool(TOOL_TYPES.ZONE_POLYGON);
    else setActiveTool(TOOL_TYPES.SELECT);
  }

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
        deviceCount={0}
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
          <FloorPlanCanvas
            ref={canvasRef}
            floor={floor}
            floorplanUrl={floor?.floorplan_url}
            zones={zones}
            devices={[]}
            editorMode={editorMode}
            activeTool={activeTool}
            selectedZoneId={selectedZoneId}
            onSelectZone={(z) => setSelectedZoneId(z.zone_id)}
            onZoneCreate={onZoneCreate}
            onZoneUpdate={onZoneUpdate}
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
