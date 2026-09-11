"use client";

// PtzOverlay (G1) — the operator PTZ control surface that attaches on top of a
// LivePlayer for a `ptz_capable` camera. It provides:
//   • an 8-direction pan/tilt pad — press-and-hold to move (continuous), release
//     to stop (pointer-down → one `move`, pointer-up/leave/blur → one `stop`);
//   • zoom in/out + focus near/far — same hold-to-move → stop;
//   • a preset bar — chips (click = goto), "＋ save preset", delete-on-hover;
//   • a patrol panel — run state, start/stop, and open the PatrolEditorModal.
//
// EVERY command goes through the owning recorder (`/vms/federation/nodes/{node}/…`).
// The VMS does not hold camera credentials and does not talk to a device: the
// recorder owns the camera, and this overlay asks it to act. There used to be a
// second, non-federated branch here that drove the VMS's own PTZ plane; it had no
// caller, because the only thing that renders this overlay is FederatedCameraDetail.
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
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type PointerEvent } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import vms from "../api";
import type { FederatedPatrol, FederatedPreset, FederatedTour, PtzMoveBody, TourOperation } from "../types";
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
type PadDir = keyof typeof DIRS;

/** The pointer handlers every hold-to-move button spreads. */
type HoldHandlers = Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onPointerDown" | "onPointerUp" | "onPointerLeave" | "onPointerCancel"
>;
type HoldPropsFn = (onStart: () => void) => HoldHandlers;

export interface PtzOverlayProps {
  /** The recorder that owns this camera. */
  nodeId: string;
  /** The camera's id ON THAT RECORDER, not its federated composite id. */
  cameraId: string;
  canControl: boolean;
}

export default function PtzOverlay({ nodeId, cameraId, canControl }: PtzOverlayProps) {
  const qc = useQueryClient();
  const [showPatrol, setShowPatrol] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  // Tracks whether a hold is active so we only ever send a single trailing stop.
  const movingRef = useRef<"ptz" | "focus" | null>(null);

  const ready = !!(nodeId && cameraId);
  const presetsKey = ["vms", "federation", "presets", nodeId, cameraId];
  const patrolKey = ["vms", "federation", "patrol", nodeId, cameraId];

  const presetsQ = useQuery({
    queryKey: presetsKey,
    queryFn: () => vms.federation.presets.list(nodeId, cameraId),
    enabled: ready,
    staleTime: 30_000,
  });
  const patrolQ = useQuery({
    queryKey: patrolKey,
    queryFn: () => vms.federation.patrol.get(nodeId, cameraId),
    enabled: ready,
    staleTime: 30_000,
  });

  // Presets come back straight off the camera, so `supported:false` (no preset
  // service on this head) is a different state from an empty list, and the bar
  // says so rather than showing "None saved" for a head that cannot store any.
  const presets: FederatedPreset[] = asItems(presetsQ.data);
  const presetsSupported = presetsQ.data?.supported !== false;
  const patrol: FederatedPatrol | undefined = patrolQ.data;
  const patrolRunning = !!patrol?.enabled;

  // The CAMERA's own tours, which are a different mechanism from the recorder's
  // patrol above: a preset tour lives in the device's firmware and keeps moving
  // after this tab closes. Both exist on the same camera and neither knows about
  // the other, so they are shown as what they are rather than merged into one
  // "patrol" that would lie about which is running.
  const toursKey = ["vms", "federation", "tours", nodeId, cameraId];
  const toursQ = useQuery({
    queryKey: toursKey,
    queryFn: () => vms.federation.tours.list(nodeId, cameraId),
    retry: false,
  });
  const tours: FederatedTour[] = asItems(toursQ.data);
  const touring = tours.some((t) => isTouring(t));

  // ── hold-to-move plumbing ───────────────────────────────────────────────
  // Each command branches on the node ids themselves (not `federated`) so the
  // federated call sees them as strings.
  // Focus is a separate motor with separate routes, so a hold has to be stopped on
  // the surface that started it — sending a PTZ stop after a focus move leaves the
  // lens driving. `movingRef` therefore records WHICH it was, not just that
  // something is moving.
  const stop = useCallback(async () => {
    const what = movingRef.current;
    if (!what) return;
    movingRef.current = null;
    try {
      if (what === "focus") await vms.federation.focus.stop(nodeId, cameraId);
      else await vms.federation.ptz(nodeId, cameraId, { action: "stop" });
    } catch (e) {
      toast.error(apiError(e, "PTZ stop failed"));
    }
  }, [nodeId, cameraId]);

  const startPanTilt = useCallback(
    async (dir: PadDir) => {
      if (!canControl || movingRef.current) return;
      movingRef.current = "ptz";
      const v = DIRS[dir];
      const cmd: PtzMoveBody = { mode: "continuous", pan: v.pan, tilt: v.tilt, zoom: 0, speed: MOVE_SPEED };
      try {
        await vms.federation.ptz(nodeId, cameraId, { action: "move", ...cmd });
      } catch (e) {
        movingRef.current = null;
        toast.error(apiError(e, "PTZ move failed"));
      }
    },
    [nodeId, cameraId, canControl]
  );

  const startZoom = useCallback(
    async (direction: "in" | "out") => {
      if (!canControl || movingRef.current) return;
      movingRef.current = "ptz";
      try {
        // Zoom is the `zoom` velocity of a continuous move, not an action of its
        // own — the recorder mounts move and stop under …/ptz and nothing else.
        await vms.federation.ptz(nodeId, cameraId, {
          action: "move",
          mode: "continuous",
          pan: 0,
          tilt: 0,
          zoom: direction === "in" ? ZOOM_SPEED : -ZOOM_SPEED,
          speed: ZOOM_SPEED,
        });
      } catch (e) {
        movingRef.current = null;
        toast.error(apiError(e, "Zoom failed"));
      }
    },
    [nodeId, cameraId, canControl]
  );

  const startFocus = useCallback(
    async (direction: "near" | "far") => {
      if (!canControl || movingRef.current) return;
      movingRef.current = "focus";
      try {
        await vms.federation.focus.move(nodeId, cameraId, { direction, speed: FOCUS_SPEED });
      } catch (e) {
        movingRef.current = null;
        toast.error(apiError(e, "Focus failed"));
      }
    },
    [nodeId, cameraId, canControl]
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
  // `token` is the DEVICE's own preset handle. There is no VMS-side preset row to
  // keep in step with it, which is the point: the preset lives in the camera's
  // firmware and the recorder reads and writes it there.
  const gotoPreset = async (token: string) => {
    if (!canControl) return;
    try {
      await vms.federation.presets.goto(nodeId, cameraId, token);
    } catch (e) {
      toast.error(apiError(e, "Could not recall preset"));
    }
  };
  const savePreset = async () => {
    if (!canControl) return;
    const name = window.prompt("Name this preset (stores the current position):");
    if (!name || !name.trim()) return;
    try {
      // No token = CREATE at the current position. Passing an existing token would
      // OVERWRITE that preset instead, which silently moves where every other
      // operator's recall of it points — so this path never sends one.
      await vms.federation.presets.save(nodeId, cameraId, name.trim());
      toast.success("Preset saved");
      qc.invalidateQueries({ queryKey: presetsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not save preset"));
    }
  };
  const deletePreset = async (token: string) => {
    if (!canControl) return;
    try {
      await vms.federation.presets.remove(nodeId, cameraId, token);
      qc.invalidateQueries({ queryKey: presetsKey });
    } catch (e) {
      toast.error(apiError(e, "Could not delete preset"));
    }
  };

  const operateTour = async (tour: string, operation: TourOperation) => {
    try {
      await vms.federation.tours.operate(nodeId, cameraId, tour, operation);
      // Re-read rather than assume: the DEVICE decides whether it started, and a
      // tour we optimistically marked "Touring" would be this console reporting
      // its own intention back to itself.
      qc.invalidateQueries({ queryKey: toursKey });
    } catch (e) {
      toast.error(apiError(e, `Could not ${operation.toLowerCase()} the tour`));
    }
  };

  // ── patrol actions ──────────────────────────────────────────────────────
  // One host-driven patrol per camera, run by the recorder. Start/stop is the
  // whole operator surface; the stop list is edited in PatrolEditorModal.
  const operatePatrol = async (operation: "start" | "stop") => {
    if (!canControl) return;
    try {
      await vms.federation.patrol.operate(nodeId, cameraId, operation);
      toast.success(operation === "start" ? "Patrol started" : "Patrol stopped");
      qc.invalidateQueries({ queryKey: patrolKey });
    } catch (e) {
      toast.error(apiError(e, `Could not ${operation} patrol`));
    }
  };

  // Pointer handlers shared by every hold-to-move button.
  const holdProps: HoldPropsFn = (onStart) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
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
        ) : !presetsSupported ? (
          /* The head has no preset service at all — a different thing from having
             one with nothing stored, and the operator should not be invited to
             save into it. */
          <span className="text-[11px] text-white/40">Not supported by this camera</span>
        ) : presets.length === 0 ? (
          <span className="text-[11px] text-white/40">None saved</span>
        ) : (
          presets.map((p) => (
            <span
              key={p.token}
              className="group/preset inline-flex items-center rounded-full border border-white/10 bg-white/5 pl-2.5 pr-1 text-[11px] text-white/90 transition hover:border-white/25 hover:bg-white/10"
            >
              <button
                type="button"
                title={canControl ? "Go to preset" : "Preset"}
                onClick={() => gotoPreset(p.token)}
                disabled={!canControl}
                className="max-w-[9rem] truncate py-1 disabled:cursor-default"
              >
                {p.name || `Preset ${p.token}`}
              </button>
              {canControl && (
                <button
                  type="button"
                  title="Delete preset"
                  onClick={() => deletePreset(p.token)}
                  className="ml-1 rounded-full p-0.5 text-white/40 opacity-0 transition hover:bg-red-500/20 hover:text-red-300 group-hover/preset:opacity-100"
                >
                  <Icon icon="heroicons-mini:x-mark" className="text-xs" />
                </button>
              )}
            </span>
          ))
        )}
        {canControl && presetsSupported && (
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

        {/* Patrol panel toggle */}
        <div className="relative ml-auto">
          <button
            type="button"
            onClick={() => setShowPatrol((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85 transition hover:bg-white/20"
          >
            <Icon icon="heroicons-outline:map" className="text-xs" />
            Patrol
            {touring && !patrolRunning && (
              <span className="rounded-sm bg-cyan-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-cyan-300">
                Tour
              </span>
            )}
            {patrolRunning && (
              <span className="rounded-sm bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
                On
              </span>
            )}
            <Icon icon="heroicons-mini:chevron-down" className={`text-xs transition ${showPatrol ? "rotate-180" : ""}`} />
          </button>

          {showPatrol && tours.length > 0 && (
            <TourStrip tours={tours} canControl={canControl} onOperate={operateTour} />
          )}
          {showPatrol && (
            <PatrolPanel
              patrol={patrol}
              loading={patrolQ.isLoading}
              canControl={canControl}
              onOperate={operatePatrol}
              onEdit={() => {
                setEditorOpen(true);
                setShowPatrol(false);
              }}
              onClose={() => setShowPatrol(false)}
            />
          )}
        </div>
      </div>

      {editorOpen && (
        <PatrolEditorModal
          nodeId={nodeId}
          cameraId={cameraId}
          presets={presets}
          patrol={patrol}
          onClose={() => setEditorOpen(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: patrolKey })}
        />
      )}
    </div>
  );
}

interface PanTiltPadProps {
  holdProps: HoldPropsFn;
  startPanTilt: (dir: PadDir) => void;
  onCenterStop: () => void;
}

// 3×3 direction pad; the center is a stop button.
function PanTiltPad({ holdProps, startPanTilt, onCenterStop }: PanTiltPadProps) {
  const cell = (dir: PadDir | null, icon = "", rotate = "") =>
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

interface HoldGroupProps {
  label: string;
  buttons: { icon: string; title: string; start: () => void }[];
  holdProps: HoldPropsFn;
}

function HoldGroup({ label, buttons, holdProps }: HoldGroupProps) {
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

interface PatrolPanelProps {
  patrol?: FederatedPatrol;
  loading: boolean;
  canControl: boolean;
  onOperate: (operation: "start" | "stop") => void;
  onEdit: () => void;
  onClose?: () => void;
}

// The recorder's ONE host-driven patrol, not a list. It shows what the recorder
// will actually do — how many stops, whether it is running, and why it cannot run
// if it cannot — instead of a roster of patrols the device has never heard of.
function PatrolPanel({ patrol, loading, canControl, onOperate, onEdit, onClose }: PatrolPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDoc = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose?.();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const stops = patrol?.stops?.length ?? 0;
  const running = !!patrol?.enabled;
  // `runnable:false` means the recorder has a patrol it cannot step — usually a
  // stop whose preset is gone from the camera. Saying so beats a Start button
  // that reports success and moves nothing.
  const blocked = patrol && patrol.runnable === false;

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-lg border border-white/10 bg-[#0b0b0d]/95 p-2 shadow-2xl backdrop-blur-md"
    >
      {loading ? (
        <p className="px-1 py-3 text-center text-[11px] text-white/50">Loading…</p>
      ) : (
        <>
          <div className="flex items-center gap-2 px-1 pb-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-white/90">
              {stops === 0 ? "No stops set" : `${stops} stop${stops === 1 ? "" : "s"}`}
            </span>
            {running && (
              <span className="rounded-sm bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase text-emerald-300">
                Running
              </span>
            )}
          </div>

          {blocked && (
            <p className="mb-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[10px] leading-snug text-amber-200">
              {patrol?.last_error || "The recorder cannot run this patrol as configured."}
            </p>
          )}

          {canControl && (
            <div className="flex items-center gap-1.5">
              {running ? (
                <PanelButton icon="heroicons-outline:stop" label="Stop" onClick={() => onOperate("stop")} />
              ) : (
                <PanelButton
                  icon="heroicons-outline:play"
                  label="Start"
                  onClick={() => onOperate("start")}
                  disabled={stops === 0 || blocked}
                />
              )}
              <PanelButton icon="heroicons-outline:pencil-square" label="Edit" onClick={onEdit} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface PanelButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function PanelButton({ icon, label, onClick, disabled }: PanelButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-1 items-center justify-center gap-1 rounded-md border border-white/15 px-2 py-1.5 text-[11px] text-white/80 transition hover:border-white/30 hover:text-white disabled:opacity-35"
    >
      <Icon icon={icon} className="text-xs" />
      {label}
    </button>
  );
}

// ── the camera's OWN preset tours ────────────────────────────────────────────
//
// Separate from PatrolPanel above, and deliberately not merged with it. The
// recorder's patrol is stepped by the recorder; a preset tour is stored in the
// camera's firmware and keeps running after every console is closed. They can
// both exist on one camera, and a single "patrol" control would have to pick one
// to report — which is how an operator stops a patrol and watches the head carry
// on moving.
//
// OPERATE ONLY. Writing a tour is authorship on the device (camera.manage), which
// a federation credential does not carry, so there is no edit here and no button
// that could only produce a refusal.

/** The DEVICE's answer, not ours. A tour survives this tab, so anything we
 *  remembered about starting one would be reporting our own history back. */
export function isTouring(tour: FederatedTour): boolean {
  return String(tour.status?.state ?? "").toLowerCase() === "touring";
}

/** What the device says it is doing, in its own vocabulary. Idle when it has not
 *  said — the ONVIF states are Idle | Touring | Paused | Extended, and inventing a
 *  fifth would be this console guessing. */
export function tourState(tour: FederatedTour): string {
  return String(tour.status?.state ?? "Idle");
}

function TourStrip({
  tours,
  canControl,
  onOperate,
}: Readonly<{
  tours: FederatedTour[];
  canControl: boolean;
  onOperate: (tour: string, operation: TourOperation) => void;
}>) {
  return (
    <div className="absolute bottom-full right-0 z-40 mb-2 w-64 rounded-xl border border-white/15 bg-[rgba(8,14,28,.96)] p-2.5 shadow-xl">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[1.2px] text-white/50">
        Camera tours
      </p>
      <ul className="space-y-1">
        {tours.map((t) => {
          const running = isTouring(t);
          return (
            <li key={t.token} className="flex items-center gap-2 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-white/85">
                {t.name || t.token}
                <span className="ml-1.5 text-white/40">{tourState(t)}</span>
              </span>
              {canControl && (
                <button
                  type="button"
                  onClick={() => onOperate(t.token, running ? "Stop" : "Start")}
                  className="shrink-0 rounded-md bg-white/10 px-2 py-0.5 text-[11px] text-white/85 transition hover:bg-white/20"
                >
                  {running ? "Stop" : "Start"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] text-white/40">
        Stored on the camera — these keep running after this window closes. Editing them is the
        recorder&apos;s.
      </p>
    </div>
  );
}
