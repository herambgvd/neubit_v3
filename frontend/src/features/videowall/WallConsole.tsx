"use client";

// Wall operator console (VW-D) — the control-room cockpit for ONE shared video
// wall. Renders the wall's monitors as tiles (grid = rows × cols), each monitor
// showing its own cell layout with the currently-assigned camera playing live
// (LivePlayer, reused from /streaming). The wall's LIVE state is SHARED: it's
// server-held and streamed over the wall SSE, so every operator + every display
// kiosk sees the same wall in real time.
//
// Operator actions (gated on vms.wall.control):
//   • Drag a camera from the rail onto a monitor cell → state/push.
//   • Click an empty cell → quick picker → push.
//   • Clear a cell / a whole monitor → state/clear.
//   • Save the current wall as a preset; apply a preset (recall).
//   • Start / stop a tour (server cycles presets on a dwell).
// Every mutation flows through the backend → NATS → SSE → all clients update.
//
// Read access (vms.wall.view) watches without mutating.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import Link from "next/link";

import { Button, Input, Modal, Spinner } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useScreens } from "@/lib/desktop";
import { useEstateCameras } from "@/features/vms/hooks/useEstateCameras";
import CameraRail from "@/features/vms/components/CameraRail";
import type { EstateCamera } from "@/features/vms/types";

import { videowall } from "./api";
import type { PresetPublic, TourPublic } from "./types";
import { useWallState } from "./hooks/useWallState";
import { sortedMonitors, filledCount, wallGridStyle } from "./wallLayout";
import MonitorTile from "./components/MonitorTile";
import WallCellPicker from "./components/WallCellPicker";
import ScreenMenu from "./components/ScreenMenu";

export interface WallConsoleProps {
  /** The wall this console drives. Next hands a dynamic route segment through as
   *  `string | string[] | undefined`, so it is accepted in that shape and
   *  normalised once below rather than at the page. */
  wallId?: string | string[];
}

/** Where a rail click / picker lands: one cell of one monitor. */
interface CellTarget {
  monitorId: string;
  cellIndex: number;
}

export default function WallConsole({ wallId: wallIdParam }: Readonly<WallConsoleProps>) {
  // `[id]` is not a catch-all, so the array form never actually occurs; "" for a
  // missing id keeps every `enabled: !!wallId` gate reading exactly as before.
  const wallId = (Array.isArray(wallIdParam) ? wallIdParam[0] : wallIdParam) ?? "";
  const { can } = useAuth();
  const control = can("vms.wall.control");
  // Desktop shell only — in a browser this is inert and ScreenMenu renders
  // nothing. Putting a monitor on the glass in front of you is a LOCAL view
  // action, so it is not gated on vms.wall.control: it changes nothing anyone
  // else can see, and the page already required vms.wall.view to reach.
  const screens = useScreens();

  const [railOpen, setRailOpen] = useState(true);
  // Written by the rail's drag callback, read by nothing yet — the console does
  // not currently change while a camera is being dragged. Kept (rather than
  // dropped) so the signal is still there when the drop affordance lands.
  const [_railDragging, setRailDragging] = useState(false);
  const [picker, setPicker] = useState<CellTarget | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [busy, setBusy] = useState(false);

  // ── Wall + monitors + cameras + presets + tours ────────────────────────
  const wallQ = useQuery({ queryKey: ["wall", wallId], queryFn: () => videowall.walls.get(wallId), enabled: !!wallId });
  const monitorsQ = useQuery({
    queryKey: ["wall-monitors", wallId],
    queryFn: () => videowall.monitors.list(wallId),
    enabled: !!wallId,
  });
  // THE WHOLE ESTATE, not this service's own camera rows.
  //
  // This asked `/vms/cameras` alone. On a single-ownership estate that list is
  // empty — every camera belongs to a recorder — so the rail had nothing to drag
  // onto a monitor, and a wall already holding federated cells could not name what
  // was in them. `useEstateCameras` merges both sources and mints the composite
  // `fed:<node>:<camera>` ids that wall cells are persisted with, which is exactly
  // what WallCell resolves a cell against.
  const { cameras, localQ: camerasQ } = useEstateCameras();
  const presetsQ = useQuery({
    queryKey: ["wall-presets", wallId],
    queryFn: () => videowall.presets.list(wallId),
    enabled: !!wallId,
  });
  const toursQ = useQuery({
    queryKey: ["wall-tours", wallId],
    queryFn: () => videowall.tours.list(wallId),
    enabled: !!wallId,
  });

  const wall = wallQ.data;
  const monitors = useMemo(() => sortedMonitors(asItems(monitorsQ.data)), [monitorsQ.data]);
  const presets = useMemo(() => asItems(presetsQ.data), [presetsQ.data]);
  const tours = useMemo(() => asItems(toursQ.data), [toursQ.data]);
  const cameraById = useMemo(() => {
    const m = new Map<string, EstateCamera>();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  // ── Live shared state (GET seed + SSE authoritative) ───────────────────
  const { state, connected, push, clearCell, clearMonitor, applyPreset } = useWallState(wallId, {
    enabled: !!wallId,
  });

  const mountedIds = useMemo(() => {
    const ids = new Set<string>();
    Object.values(state || {}).forEach((mon) =>
      Object.values(mon || {}).forEach((cam) => cam && ids.add(cam)),
    );
    return ids;
  }, [state]);

  const onlineCount = cameras.filter((c) => c.status === "online").length;
  const liveCount = filledCount(state);

  // First empty (monitor, cell) across the wall — where a rail CLICK lands.
  const firstEmpty = useMemo(() => {
    // Collect then take the first, rather than returning out of a nested loop:
    // the compiler cannot preserve a memo it cannot follow, and a wall is at most
    // a few dozen cells, so walking all of them costs nothing.
    const empties = monitors.flatMap((mon) => {
      const cap = Number(mon.layout) || 1;
      const cells = state?.[mon.id] ?? {};
      return Array.from({ length: cap }, (_, i) => i)
        .filter((i) => !cells[String(i)])
        .map((i) => ({ monitorId: mon.id, cellIndex: i }));
    });
    return empties[0] ?? null;
  }, [monitors, state]);

  // ── mutations ──────────────────────────────────────────────────────────
  const guard = () => {
    if (!control) {
      toast.error("You don't have permission to control this wall.");
      return false;
    }
    return true;
  };

  const doPush = (monitorId: string, cellIndex: number, cameraId: string) => {
    if (!guard()) return;
    push(monitorId, cellIndex, cameraId).catch((e) => toast.error(apiError(e, "Could not update the wall")));
  };
  const doClearCell = (monitorId: string, cellIndex: number) => {
    if (!guard()) return;
    clearCell(monitorId, cellIndex).catch((e) => toast.error(apiError(e, "Could not clear the cell")));
  };
  const doClearMonitor = (monitorId: string) => {
    if (!guard()) return;
    clearMonitor(monitorId).catch((e) => toast.error(apiError(e, "Could not clear the monitor")));
  };

  const pickFromRail = (cam: EstateCamera) => {
    if (!guard()) return;
    if (!firstEmpty) {
      toast.message("Wall is full — clear a cell first.");
      return;
    }
    doPush(firstEmpty.monitorId, firstEmpty.cellIndex, cam.id);
  };

  const savePreset = async () => {
    const name = saveName.trim();
    if (!name || !guard()) return;
    setBusy(true);
    try {
      await videowall.presets.create(wallId, { name }); // state omitted → snapshot live
      toast.success(`Preset “${name}” saved`);
      setSaveName("");
      setSaveOpen(false);
      presetsQ.refetch();
    } catch (e) {
      toast.error(apiError(e, "Could not save the preset"));
    } finally {
      setBusy(false);
    }
  };

  const recallPreset = async (preset: PresetPublic) => {
    if (!guard()) return;
    try {
      await applyPreset(preset.id);
      toast.success(`Applied “${preset.name}”`);
    } catch (e) {
      toast.error(apiError(e, "Could not apply the preset"));
    }
  };

  const toggleTour = async (tour: TourPublic) => {
    if (!guard()) return;
    try {
      if (tour.is_running) await videowall.tours.stop(wallId, tour.id);
      else await videowall.tours.start(wallId, tour.id);
      toursQ.refetch();
      toast.success(tour.is_running ? "Tour stopped" : `Tour “${tour.name}” started`);
    } catch (e) {
      toast.error(apiError(e, "Could not toggle the tour"));
    }
  };

  // ── render ─────────────────────────────────────────────────────────────
  if (wallQ.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center gap-2 text-nb-soft">
        <Spinner /> Loading wall…
      </div>
    );
  }
  if (wallQ.isError || !wall) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-nb-soft">
        <Icon icon="heroicons:exclamation-triangle" className="text-3xl text-nb-warn" />
        <p>Wall not found or unavailable.</p>
        <Link href="/wall" className="text-nb-tealb hover:underline">
          Back to walls
        </Link>
      </div>
    );
  }

  const rows = wall.rows || 1;
  const cols = wall.cols || 1;

  return (
    <div
      className="flex h-[calc(100vh-3.5rem)] flex-col text-nb-ink"
      style={{ background: "var(--nb-backdrop)" }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-nb-haze/22 bg-nb-surface/55 px-3 py-2 backdrop-blur-xs">
        <Link
          href="/wall"
          className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-xs font-medium text-nb-soft transition hover:bg-nb-mist/7 hover:text-nb-tealb"
        >
          <Icon icon="heroicons-outline:arrow-left" className="text-sm" />
          Walls
        </Link>
        <button
          type="button"
          onClick={() => setRailOpen((o) => !o)}
          title="Toggle camera rail"
          className="inline-flex h-8 items-center gap-1 rounded-[8px] border border-nb-mist/22 bg-nb-surface/65 px-2 text-xs font-medium text-nb-soft transition hover:border-nb-teal/50 hover:text-nb-tealb"
        >
          <Icon icon={railOpen ? "heroicons-outline:chevron-left" : "heroicons-outline:bars-3"} className="text-sm" />
          Cameras
        </button>

        <div className="mx-1 flex min-w-0 items-center gap-2">
          <Icon icon="heroicons:computer-desktop" className="shrink-0 text-base text-nb-tealb" />
          <span className="truncate text-sm font-semibold text-nb-ink">{wall.name}</span>
          <span className="shrink-0 rounded-full border border-nb-haze/22 bg-nb-mist/6 px-2 py-0.5 font-mono text-[10px] text-nb-faint">
            {monitors.length} monitor{monitors.length === 1 ? "" : "s"} · {rows}×{cols}
          </span>
        </div>

        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
            connected
              ? "border-nb-good/45 bg-nb-good/10 text-nb-good"
              : "border-nb-warn/45 bg-nb-warn/10 text-nb-warn"
          }`}
          title={connected ? "Live shared state connected" : "Reconnecting to shared state…"}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? "rgb(var(--nb-c-good))" : "rgb(var(--nb-c-warn))", boxShadow: `0 0 5px ${connected ? "rgb(var(--nb-c-good))" : "rgb(var(--nb-c-warn))"}` }}
          />
          {connected ? "Synced" : "Sync…"}
        </span>
        <span className="font-mono text-[11px] text-nb-faint">{liveCount} live</span>

        <div className="ml-auto flex items-center gap-1.5">
          <ScreenMenu wall={wall} monitors={monitors} screens={screens} />
          {control && (
            <>
              <PresetMenu presets={presets} onApply={recallPreset} onSave={() => setSaveOpen(true)} onRefetch={() => presetsQ.refetch()} wallId={wallId} />
              <TourMenu tours={tours} onToggle={toggleTour} />
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {railOpen && (
          <CameraRail
            cameras={cameras}
            mountedIds={mountedIds}
            onPick={pickFromRail}
            onDragStateChange={setRailDragging}
            isLoading={camerasQ.isLoading}
            onlineCount={onlineCount}
            liveCount={liveCount}
          />
        )}

        <main className="relative min-w-0 flex-1 overflow-auto bg-nb-surface3/60 p-2">
          {monitors.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-nb-soft">
              <Icon icon="heroicons-outline:computer-desktop" className="text-4xl text-nb-tealb" />
              <p className="text-sm">This wall has no monitors yet.</p>
              {can("vms.wall.manage") && (
                <Link href="/config/video-wall" className="text-nb-tealb hover:underline">
                  Add monitors in Wall management →
                </Link>
              )}
            </div>
          ) : (
            <div className="grid h-full min-h-0 gap-2" style={wallGridStyle(rows, cols)}>
              {monitors.map((mon) => (
                <MonitorTile
                  key={mon.id}
                  monitor={mon}
                  state={state}
                  cameraById={cameraById}
                  control={control}
                  onAssign={(cellIndex, cameraId) => doPush(mon.id, cellIndex, cameraId)}
                  onClearCell={(cellIndex) => doClearCell(mon.id, cellIndex)}
                  onClearMonitor={() => doClearMonitor(mon.id)}
                  onPickCell={(cellIndex) => control && setPicker({ monitorId: mon.id, cellIndex })}
                />
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Cell picker (click an empty cell) */}
      <WallCellPicker
        open={!!picker}
        cameras={cameras}
        mountedIds={mountedIds}
        onPick={(camId: string) => {
          if (picker) doPush(picker.monitorId, picker.cellIndex, camId);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />

      {/* Save preset */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save wall preset"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={savePreset} disabled={!saveName.trim() || busy}>
              {busy ? "Saving…" : "Save preset"}
            </Button>
          </>
        }
      >
        <Input
          label="Preset name"
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="e.g. Lobby overview"
          autoFocus
          onKeyDown={(e) => e.key === "Enter" && savePreset()}
        />
        <p className="mt-2 text-xs text-nb-faint">
          Snapshots the wall&apos;s current live state ({liveCount} camera{liveCount === 1 ? "" : "s"}). Recall it in one click, or add it to a tour.
        </p>
      </Modal>
    </div>
  );
}

// ── Preset dropdown ────────────────────────────────────────────────────────
interface PresetMenuProps {
  presets: PresetPublic[];
  onApply: (preset: PresetPublic) => void;
  /** Opens the "save current wall" modal. */
  onSave?: () => void;
  /** Accepted for the caller that passes them; the menu itself refetches nothing. */
  onRefetch?: () => void;
  wallId?: string;
}

function PresetMenu({ presets, onApply, onSave }: Readonly<PresetMenuProps>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-nb-mist/22 bg-nb-surface/65 px-2.5 text-xs font-medium text-nb-soft transition hover:border-nb-teal/50 hover:text-nb-tealb"
      >
        <Icon icon="heroicons-outline:bookmark" className="text-sm text-nb-faint" />
        Presets
        {presets.length > 0 && (
          <span className="rounded-full border border-nb-haze/22 bg-nb-mist/7 px-1.5 font-mono text-[9px] font-semibold text-nb-faint">{presets.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-[13px] border border-nb-haze/22 bg-nb-surface/97 py-1 shadow-2xl backdrop-blur-xs">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">Presets</span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSave?.();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-nb-tealb transition hover:bg-nb-teal/12"
            >
              <Icon icon="heroicons-mini:plus" className="text-xs" />
              Save current
            </button>
          </div>
          {presets.length === 0 ? (
            <div className="px-3 py-3 text-xs text-nb-faint">No presets yet — arrange the wall and Save current.</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-nb-haze/22 pt-1">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onApply(p);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-nb-mist/7"
                  >
                    <Icon icon="heroicons-outline:bookmark" className="shrink-0 text-xs text-nb-faint" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-nb-ink">{p.name}</span>
                    {p.is_default && <span className="font-mono text-[9px] text-nb-faint">default</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Tour dropdown ──────────────────────────────────────────────────────────
interface TourMenuProps {
  tours: TourPublic[];
  onToggle: (tour: TourPublic) => void;
}

function TourMenu({ tours, onToggle }: Readonly<TourMenuProps>) {
  const [open, setOpen] = useState(false);
  const running = tours.find((t) => t.is_running);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`inline-flex h-8 items-center gap-1.5 rounded-[8px] border px-2.5 text-xs font-medium transition ${
          running
            ? "border-nb-teal/50 bg-nb-teal/15 text-nb-tealb"
            : "border-nb-mist/22 bg-nb-surface/65 text-nb-soft hover:border-nb-teal/50 hover:text-nb-tealb"
        }`}
      >
        <Icon icon={running ? "heroicons-solid:play" : "heroicons:arrow-path-rounded-square"} className="text-sm" />
        {running ? running.name : "Tours"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-[13px] border border-nb-haze/22 bg-nb-surface/97 py-1 shadow-2xl backdrop-blur-xs">
          <div className="px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-nb-faint">Tours</div>
          {tours.length === 0 ? (
            <div className="px-3 py-3 text-xs text-nb-faint">No tours — create one in Wall management.</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-nb-haze/22 pt-1">
              {tours.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onToggle(t);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-nb-mist/7"
                  >
                    <Icon
                      icon={t.is_running ? "heroicons-solid:stop" : "heroicons-solid:play"}
                      className={`shrink-0 text-xs ${t.is_running ? "text-nb-crit" : "text-nb-good"}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-nb-ink">{t.name}</span>
                    <span className="font-mono text-[9px] text-nb-faint">
                      {(t.preset_ids || []).length} · {t.dwell_seconds}s
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
