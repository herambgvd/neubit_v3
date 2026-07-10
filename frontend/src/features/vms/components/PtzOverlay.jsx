"use client";

// PtzOverlay (G1) — the operator PTZ control surface that attaches on top of a
// LivePlayer for a `ptz_capable` camera. It provides:
//   • an 8-direction pan/tilt pad — press-and-hold to move (continuous), release
//     to stop (pointer-down → one `move`, pointer-up/leave/blur → one `stop`);
//   • zoom in/out + focus near/far — same hold-to-move → stop;
//   • a preset bar — chips (click = goto), "＋ save preset", delete-on-hover;
//   • a patrol menu — list, start/stop, and open the PatrolEditorModal.
//
// Network discipline: continuous mode sends exactly ONE move on press and ONE
// stop on release — never a stream of calls. We ALWAYS send stop on release,
// pointer-leave, window blur, and unmount so a held button can never leave the
// camera drifting.
//
// Gating: reads (list presets/patrols) need `vms.live.view` (any live viewer);
// all MOVEMENTS and writes gate on `vms.ptz.control`. When the operator lacks
// that perm the pad/zoom/focus/save/patrol-write controls are hidden and only
// the (read-only) preset list + patrol status show.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import vms from "../api";
import PatrolEditorModal from "./PatrolEditorModal";

const MOVE_SPEED = 0.6;
const ZOOM_SPEED = 0.5;
const FOCUS_SPEED = 0.5;

// Pan/tilt velocity vectors for the 8 pad directions (pan = x, tilt = y).
const DIRS = {
  up: { pan: 0, tilt: MOVE_SPEED },
  down: { pan: 0, tilt: -MOVE_SPEED },
  left: { pan: -MOVE_SPEED, tilt: 0 },
  right: { pan: MOVE_SPEED, tilt: 0 },
  "up-left": { pan: -MOVE_SPEED, tilt: MOVE_SPEED },
  "up-right": { pan: MOVE_SPEED, tilt: MOVE_SPEED },
  "down-left": { pan: -MOVE_SPEED, tilt: -MOVE_SPEED },
  "down-right": { pan: MOVE_SPEED, tilt: -MOVE_SPEED },
};

export default function PtzOverlay({ cameraId, canControl }) {
  const qc = useQueryClient();
  const [showPatrols, setShowPatrols] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  // Tracks whether a hold is active so we only ever send a single trailing stop.
  const movingRef = useRef(false);

  const presetsKey = ["vms", "ptz", "presets", cameraId];
  const patrolsKey = ["vms", "ptz", "patrols", cameraId];

  const presetsQ = useQuery({
    queryKey: presetsKey,
    queryFn: () => vms.ptz.presets.list(cameraId),
    enabled: !!cameraId,
    staleTime: 30_000,
  });
  const patrolsQ = useQuery({
    queryKey: patrolsKey,
    queryFn: () => vms.ptz.patrols.list(cameraId),
    enabled: !!cameraId,
    staleTime: 30_000,
  });

  const presets = itemsOf(presetsQ.data);
  const patrols = itemsOf(patrolsQ.data);

  // ── hold-to-move plumbing ───────────────────────────────────────────────
  const stop = useCallback(async () => {
    if (!movingRef.current) return;
    movingRef.current = false;
    try {
      await vms.ptz.stop(cameraId);
    } catch (e) {
      toast.error(apiError(e, "PTZ stop failed"));
    }
  }, [cameraId]);

  const startPanTilt = useCallback(
    async (dir) => {
      if (!canControl || movingRef.current) return;
      movingRef.current = true;
      const v = DIRS[dir];
      try {
        await vms.ptz.move(cameraId, {
          mode: "continuous",
          pan: v.pan,
          tilt: v.tilt,
          zoom: 0,
          speed: MOVE_SPEED,
        });
      } catch (e) {
        movingRef.current = false;
        toast.error(apiError(e, "PTZ move failed"));
      }
    },
    [cameraId, canControl]
  );

  const startZoom = useCallback(
    async (direction) => {
      if (!canControl || movingRef.current) return;
      movingRef.current = true;
      try {
        await vms.ptz.zoom(cameraId, { direction, speed: ZOOM_SPEED });
      } catch (e) {
        movingRef.current = false;
        toast.error(apiError(e, "Zoom failed"));
      }
    },
    [cameraId, canControl]
  );

  const startFocus = useCallback(
    async (direction) => {
      if (!canControl || movingRef.current) return;
      movingRef.current = true;
      try {
        await vms.ptz.focus(cameraId, { direction, speed: FOCUS_SPEED });
      } catch (e) {
        movingRef.current = false;
        toast.error(apiError(e, "Focus failed"));
      }
    },
    [cameraId, canControl]
  );

  // Safety net: always stop on window blur / tab hide / unmount so a held button
  // that never got its pointer-up (alt-tab mid-hold) can't leave the camera moving.
  useEffect(() => {
    const onBlur = () => stop();
    const onVis = () => document.hidden && stop();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [stop]);

  // ── preset actions ──────────────────────────────────────────────────────
  const gotoPreset = async (pid) => {
    if (!canControl) return;
    try {
      await vms.ptz.presets.goto(cameraId, pid);
    } catch (e) {
      toast.error(apiError(e, "Could not recall preset"));
    }
  };
  const savePreset = async () => {
    if (!canControl) return;
    const name = window.prompt("Name this preset (stores the current position):");
    if (!name || !name.trim()) return;
    try {
      await vms.ptz.presets.create(cameraId, name.trim());
      toast.success("Preset saved");
      qc.invalidateQueries({ queryKey: presetsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not save preset"));
    }
  };
  const deletePreset = async (pid) => {
    if (!canControl) return;
    try {
      await vms.ptz.presets.remove(cameraId, pid);
      qc.invalidateQueries({ queryKey: presetsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not delete preset"));
    }
  };

  // ── patrol actions ──────────────────────────────────────────────────────
  const startPatrol = async (id) => {
    try {
      await vms.ptz.patrols.start(cameraId, id);
      toast.success("Patrol started");
      qc.invalidateQueries({ queryKey: patrolsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not start patrol"));
    }
  };
  const stopPatrol = async (id) => {
    try {
      await vms.ptz.patrols.stop(cameraId, id);
      toast.success("Patrol stopped");
      qc.invalidateQueries({ queryKey: patrolsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not stop patrol"));
    }
  };
  const deletePatrol = async (id) => {
    try {
      await vms.ptz.patrols.remove(cameraId, id);
      qc.invalidateQueries({ queryKey: patrolsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not delete patrol"));
    }
  };

  // Pointer handlers shared by every hold-to-move button.
  const holdProps = (onStart) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      onStart();
    },
    onPointerUp: () => stop(),
    onPointerLeave: () => stop(),
    onPointerCancel: () => stop(),
  });

  return (
    <div className="pointer-events-auto flex flex-col gap-2 rounded-xl border border-white/10 bg-black/70 p-2.5 text-white shadow-2xl backdrop-blur-md">
      {canControl && (
        <div className="flex items-start gap-2.5">
          {/* Pan/tilt pad */}
          <PanTiltPad holdProps={holdProps} startPanTilt={startPanTilt} onCenterStop={stop} />

          {/* Zoom + focus columns */}
          <div className="flex flex-col gap-2">
            <HoldGroup
              label="Zoom"
              buttons={[
                { icon: "heroicons-outline:magnifying-glass-plus", title: "Zoom in", start: () => startZoom("in") },
                { icon: "heroicons-outline:magnifying-glass-minus", title: "Zoom out", start: () => startZoom("out") },
              ]}
              holdProps={holdProps}
            />
            <HoldGroup
              label="Focus"
              buttons={[
                { icon: "heroicons-outline:eye", title: "Focus near", start: () => startFocus("near") },
                { icon: "heroicons-outline:eye-slash", title: "Focus far", start: () => startFocus("far") },
              ]}
              holdProps={holdProps}
            />
          </div>
        </div>
      )}

      {/* Preset bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-white/10 pt-2">
        <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/45">
          Presets
        </span>
        {presetsQ.isLoading ? (
          <span className="text-[11px] text-white/50">Loading…</span>
        ) : presets.length === 0 ? (
          <span className="text-[11px] text-white/40">None saved</span>
        ) : (
          presets.map((p) => (
            <span
              key={p.id}
              className="group/preset inline-flex items-center rounded-full border border-white/10 bg-white/5 pl-2.5 pr-1 text-[11px] text-white/90 transition hover:border-white/25 hover:bg-white/10"
            >
              <button
                type="button"
                title={canControl ? "Go to preset" : "Preset"}
                onClick={() => gotoPreset(p.id)}
                disabled={!canControl}
                className="max-w-[9rem] truncate py-1 disabled:cursor-default"
              >
                {p.name || `Preset ${p.id}`}
              </button>
              {canControl && (
                <button
                  type="button"
                  title="Delete preset"
                  onClick={() => deletePreset(p.id)}
                  className="ml-1 rounded-full p-0.5 text-white/40 opacity-0 transition hover:bg-red-500/20 hover:text-red-300 group-hover/preset:opacity-100"
                >
                  <Icon icon="heroicons-mini:x-mark" className="text-xs" />
                </button>
              )}
            </span>
          ))
        )}
        {canControl && (
          <button
            type="button"
            onClick={savePreset}
            title="Save current position as a preset"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-white/25 px-2 py-1 text-[11px] text-white/70 transition hover:border-white/40 hover:text-white"
          >
            <Icon icon="heroicons-mini:plus" className="text-xs" />
            Save
          </button>
        )}

        {/* Patrol menu toggle */}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setShowPatrols((s) => !s)}
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85 transition hover:bg-white/20"
          >
            <Icon icon="heroicons-outline:map" className="text-xs" />
            Patrols
            <Icon icon="heroicons-mini:chevron-down" className={`text-xs transition ${showPatrols ? "rotate-180" : ""}`} />
          </button>

          {showPatrols && (
            <PatrolMenu
              patrols={patrols}
              loading={patrolsQ.isLoading}
              canControl={canControl}
              onStart={startPatrol}
              onStop={stopPatrol}
              onDelete={deletePatrol}
              onEdit={(p) => {
                setEditing(p);
                setEditorOpen(true);
                setShowPatrols(false);
              }}
              onNew={() => {
                setEditing(null);
                setEditorOpen(true);
                setShowPatrols(false);
              }}
              onClose={() => setShowPatrols(false)}
            />
          )}
        </div>
      </div>

      {editorOpen && (
        <PatrolEditorModal
          cameraId={cameraId}
          presets={presets}
          patrol={editing}
          onClose={() => setEditorOpen(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: patrolsKey })}
        />
      )}
    </div>
  );
}

// 3×3 direction pad; the center is a stop button.
function PanTiltPad({ holdProps, startPanTilt, onCenterStop }) {
  const cell = (dir, icon, rotate = "") =>
    dir ? (
      <button
        type="button"
        title={`Pan ${dir}`}
        {...holdProps(() => startPanTilt(dir))}
        className="flex items-center justify-center rounded-md bg-white/5 text-white/80 transition hover:bg-white/15 hover:text-white active:bg-blue-500/40 active:text-white"
      >
        <Icon icon={icon} className={`text-lg ${rotate}`} />
      </button>
    ) : (
      <button
        type="button"
        title="Stop"
        onClick={onCenterStop}
        className="flex items-center justify-center rounded-md bg-white/5 text-white/50 transition hover:bg-white/15 hover:text-white"
      >
        <Icon icon="heroicons-outline:stop" className="text-base" />
      </button>
    );

  return (
    <div className="grid grid-cols-3 gap-1" style={{ width: 128, height: 128 }}>
      {cell("up-left", "heroicons-mini:arrow-up-left")}
      {cell("up", "heroicons-mini:arrow-up")}
      {cell("up-right", "heroicons-mini:arrow-up-right")}
      {cell("left", "heroicons-mini:arrow-left")}
      {cell(null)}
      {cell("right", "heroicons-mini:arrow-right")}
      {cell("down-left", "heroicons-mini:arrow-down-left")}
      {cell("down", "heroicons-mini:arrow-down")}
      {cell("down-right", "heroicons-mini:arrow-down-right")}
    </div>
  );
}

function HoldGroup({ label, buttons, holdProps }) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-9 text-right text-[10px] font-semibold uppercase tracking-wide text-white/45">
        {label}
      </span>
      {buttons.map((b) => (
        <button
          key={b.title}
          type="button"
          title={b.title}
          {...holdProps(b.start)}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-white/5 text-white/80 transition hover:bg-white/15 hover:text-white active:bg-blue-500/40 active:text-white"
        >
          <Icon icon={b.icon} className="text-base" />
        </button>
      ))}
    </div>
  );
}

function PatrolMenu({ patrols, loading, canControl, onStart, onStop, onDelete, onEdit, onNew, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-lg border border-white/10 bg-[#0b0b0d]/95 p-1.5 shadow-2xl backdrop-blur-md"
    >
      <div className="max-h-56 overflow-y-auto">
        {loading ? (
          <p className="px-2 py-3 text-center text-[11px] text-white/50">Loading…</p>
        ) : patrols.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-white/40">No patrols yet</p>
        ) : (
          patrols.map((p) => {
            const running = !!(p.is_running ?? p.running ?? p.active);
            return (
              <div
                key={p.id}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 hover:bg-white/5"
              >
                <span className="min-w-0 flex-1 truncate text-[12px] text-white/90">
                  {p.name || `Patrol ${p.id}`}
                  {running && (
                    <span className="ml-1.5 rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
                      Running
                    </span>
                  )}
                </span>
                {running ? (
                  <MenuIcon icon="heroicons-outline:stop" title="Stop patrol" onClick={() => onStop(p.id)} />
                ) : (
                  <MenuIcon icon="heroicons-outline:play" title="Start patrol" onClick={() => onStart(p.id)} />
                )}
                {canControl && (
                  <>
                    <MenuIcon icon="heroicons-outline:pencil-square" title="Edit patrol" onClick={() => onEdit(p)} />
                    <MenuIcon icon="heroicons-outline:trash" title="Delete patrol" onClick={() => onDelete(p.id)} danger />
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
      {canControl && (
        <button
          type="button"
          onClick={onNew}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-white/20 px-2 py-1.5 text-[11px] text-white/70 transition hover:border-white/40 hover:text-white"
        >
          <Icon icon="heroicons-mini:plus" className="text-xs" />
          New patrol
        </button>
      )}
    </div>
  );
}

function MenuIcon({ icon, title, onClick, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`shrink-0 rounded p-1 transition ${
        danger ? "text-white/50 hover:bg-red-500/20 hover:text-red-300" : "text-white/60 hover:bg-white/10 hover:text-white"
      }`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}

// Normalize { items } | bare array | null → array.
function itemsOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  return [];
}
