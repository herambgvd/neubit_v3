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
import { vms } from "@/features/vms/api";
import CameraRail from "@/features/vms/components/CameraRail";

import { videowall } from "./api";
import { useWallState } from "./hooks/useWallState";
import { sortedMonitors, filledCount, wallGridStyle } from "./wallLayout";
import MonitorTile from "./components/MonitorTile";
import WallCellPicker from "./components/WallCellPicker";

export default function WallConsole({ wallId }) {
  const { can } = useAuth();
  const control = can("vms.wall.control");

  const [railOpen, setRailOpen] = useState(true);
  const [railDragging, setRailDragging] = useState(false);
  const [picker, setPicker] = useState(null); // { monitorId, cellIndex }
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
  const camerasQ = useQuery({
    queryKey: ["vms-wall-cameras"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    refetchInterval: 30_000,
  });
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
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const presets = useMemo(() => asItems(presetsQ.data), [presetsQ.data]);
  const tours = useMemo(() => asItems(toursQ.data), [toursQ.data]);
  const cameraById = useMemo(() => {
    const m = new Map();
    cameras.forEach((c) => m.set(c.id, c));
    return m;
  }, [cameras]);

  // ── Live shared state (GET seed + SSE authoritative) ───────────────────
  const { state, connected, push, clearCell, clearMonitor, applyPreset } = useWallState(wallId, {
    enabled: !!wallId,
  });

  const mountedIds = useMemo(() => {
    const ids = new Set();
    Object.values(state || {}).forEach((mon) =>
      Object.values(mon || {}).forEach((cam) => cam && ids.add(cam)),
    );
    return ids;
  }, [state]);

  const onlineCount = cameras.filter((c) => c.status === "online").length;
  const liveCount = filledCount(state);

  // First empty (monitor, cell) across the wall — where a rail CLICK lands.
  const firstEmpty = useMemo(() => {
    for (const mon of monitors) {
      const cap = Number(mon.layout) || 1;
      for (let i = 0; i < cap; i += 1) {
        if (!state?.[mon.id]?.[String(i)]) return { monitorId: mon.id, cellIndex: i };
      }
    }
    return null;
  }, [monitors, state]);

  // ── mutations ──────────────────────────────────────────────────────────
  const guard = () => {
    if (!control) {
      toast.error("You don't have permission to control this wall.");
      return false;
    }
    return true;
  };

  const doPush = (monitorId, cellIndex, cameraId) => {
    if (!guard()) return;
    push(monitorId, cellIndex, cameraId).catch((e) => toast.error(apiError(e, "Could not update the wall")));
  };
  const doClearCell = (monitorId, cellIndex) => {
    if (!guard()) return;
    clearCell(monitorId, cellIndex).catch((e) => toast.error(apiError(e, "Could not clear the cell")));
  };
  const doClearMonitor = (monitorId) => {
    if (!guard()) return;
    clearMonitor(monitorId).catch((e) => toast.error(apiError(e, "Could not clear the monitor")));
  };

  const pickFromRail = (cam) => {
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

  const recallPreset = async (preset) => {
    if (!guard()) return;
    try {
      await applyPreset(preset.id);
      toast.success(`Applied “${preset.name}”`);
    } catch (e) {
      toast.error(apiError(e, "Could not apply the preset"));
    }
  };

  const toggleTour = async (tour) => {
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
      <div className="flex h-[60vh] items-center justify-center gap-2 text-[#aec2e8]">
        <Spinner /> Loading wall…
      </div>
    );
  }
  if (wallQ.isError || !wall) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-[#aec2e8]">
        <Icon icon="heroicons-outline:exclamation-triangle" className="text-3xl text-[#fbbf24]" />
        <p>Wall not found or unavailable.</p>
        <Link href="/wall" className="text-[#67e8f9] hover:underline">
          Back to walls
        </Link>
      </div>
    );
  }

  const rows = wall.rows || 1;
  const cols = wall.cols || 1;

  return (
    <div
      className="flex h-[calc(100vh-3.5rem)] flex-col text-[#f2f6ff]"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[rgba(160,150,245,.22)] bg-[rgba(10,18,40,.55)] px-3 py-2 backdrop-blur-sm">
        <Link
          href="/wall"
          className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-xs font-medium text-[#aec2e8] transition hover:bg-[rgba(150,180,245,.07)] hover:text-[#67e8f9]"
        >
          <Icon icon="heroicons-outline:arrow-left" className="text-sm" />
          Walls
        </Link>
        <button
          type="button"
          onClick={() => setRailOpen((o) => !o)}
          title="Toggle camera rail"
          className="inline-flex h-8 items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.65)] px-2 text-xs font-medium text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        >
          <Icon icon={railOpen ? "heroicons-outline:chevron-left" : "heroicons-outline:bars-3"} className="text-sm" />
          Cameras
        </button>

        <div className="mx-1 flex min-w-0 items-center gap-2">
          <Icon icon="heroicons:computer-desktop" className="shrink-0 text-base text-[#67e8f9]" />
          <span className="truncate text-sm font-semibold text-[#f2f6ff]">{wall.name}</span>
          <span className="shrink-0 rounded-full border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.06)] px-2 py-0.5 font-mono text-[10px] text-[#9a92c8]">
            {monitors.length} monitor{monitors.length === 1 ? "" : "s"} · {rows}×{cols}
          </span>
        </div>

        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
            connected
              ? "border-[rgba(52,211,153,.45)] bg-[rgba(52,211,153,.1)] text-[#34d399]"
              : "border-[rgba(251,191,36,.45)] bg-[rgba(251,191,36,.1)] text-[#fbbf24]"
          }`}
          title={connected ? "Live shared state connected" : "Reconnecting to shared state…"}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? "#34d399" : "#fbbf24", boxShadow: `0 0 5px ${connected ? "#34d399" : "#fbbf24"}` }}
          />
          {connected ? "Synced" : "Sync…"}
        </span>
        <span className="font-mono text-[11px] text-[#9a92c8]">{liveCount} live</span>

        <div className="ml-auto flex items-center gap-1.5">
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

        <main className="relative min-w-0 flex-1 overflow-auto bg-[rgba(6,11,26,.6)] p-2">
          {monitors.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-[#aec2e8]">
              <Icon icon="heroicons-outline:computer-desktop" className="text-4xl text-[#67e8f9]" />
              <p className="text-sm">This wall has no monitors yet.</p>
              {can("vms.wall.manage") && (
                <Link href="/config/video-wall" className="text-[#67e8f9] hover:underline">
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
        onPick={(camId) => {
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
        <p className="mt-2 text-xs text-[#9a92c8]">
          Snapshots the wall's current live state ({liveCount} camera{liveCount === 1 ? "" : "s"}). Recall it in one click, or add it to a tour.
        </p>
      </Modal>
    </div>
  );
}

// ── Preset dropdown ────────────────────────────────────────────────────────
function PresetMenu({ presets, onApply, onSave }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.65)] px-2.5 text-xs font-medium text-[#aec2e8] transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
      >
        <Icon icon="heroicons-outline:bookmark" className="text-sm text-[#9a92c8]" />
        Presets
        {presets.length > 0 && (
          <span className="rounded-full border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.07)] px-1.5 font-mono text-[9px] font-semibold text-[#9a92c8]">{presets.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(12,21,44,.97)] py-1 shadow-2xl backdrop-blur-sm">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Presets</span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSave?.();
                setOpen(false);
              }}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[#67e8f9] transition hover:bg-[rgba(34,211,238,.12)]"
            >
              <Icon icon="heroicons-mini:plus" className="text-xs" />
              Save current
            </button>
          </div>
          {presets.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[#9a92c8]">No presets yet — arrange the wall and Save current.</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-[rgba(160,150,245,.22)] pt-1">
              {presets.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onApply(p);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[rgba(150,180,245,.07)]"
                  >
                    <Icon icon="heroicons-outline:bookmark" className="shrink-0 text-xs text-[#9a92c8]" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#f2f6ff]">{p.name}</span>
                    {p.is_default && <span className="font-mono text-[9px] text-[#9a92c8]">default</span>}
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
function TourMenu({ tours, onToggle }) {
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
            ? "border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9]"
            : "border-[rgba(150,180,245,.22)] bg-[rgba(10,18,40,.65)] text-[#aec2e8] hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9]"
        }`}
      >
        <Icon icon={running ? "heroicons-solid:play" : "heroicons-outline:arrow-path-rounded-square"} className="text-sm" />
        {running ? running.name : "Tours"}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(12,21,44,.97)] py-1 shadow-2xl backdrop-blur-sm">
          <div className="px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Tours</div>
          {tours.length === 0 ? (
            <div className="px-3 py-3 text-xs text-[#9a92c8]">No tours — create one in Wall management.</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-[rgba(160,150,245,.22)] pt-1">
              {tours.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onToggle(t);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[rgba(150,180,245,.07)]"
                  >
                    <Icon
                      icon={t.is_running ? "heroicons-solid:stop" : "heroicons-solid:play"}
                      className={`shrink-0 text-xs ${t.is_running ? "text-[#f87171]" : "text-[#34d399]"}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#f2f6ff]">{t.name}</span>
                    <span className="font-mono text-[9px] text-[#9a92c8]">
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
