"use client";

// Wall management (VW-D) — Config → Video Wall. The admin surface for the shared
// control-room video walls: create/edit walls (name, site, monitor grid), manage
// each wall's MONITORS (add/place, kind browser|decoder, cell layout, decoder
// binding), manage PRESETS and TOURS, and register hardware DECODERS.
//
// Perm-gated on vms.wall.manage (writes). Reads need vms.wall.view. Bound to the
// VW-A backend (/api/v1/vms/walls/...) + the VW-B decoder endpoints
// (/api/v1/vms/decoders — degrades cleanly if VW-B isn't live yet).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import Link from "next/link";

import { Button, ConfirmDialog, EmptyState, PageHeader, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { asItems } from "@/lib/format";
import { apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import { videowall } from "./api";
import { sortedMonitors, monitorGrid, DECODER_BRANDS } from "./wallLayout";
import WallFormModal from "./components/WallFormModal";
import MonitorFormModal from "./components/MonitorFormModal";
import DecoderFormModal from "./components/DecoderFormModal";
import TourFormModal from "./components/TourFormModal";

const TABS = [
  { key: "monitors", label: "Monitors", icon: "heroicons:computer-desktop" },
  { key: "presets", label: "Presets", icon: "heroicons-outline:bookmark" },
  { key: "tours", label: "Tours", icon: "heroicons-outline:arrow-path-rounded-square" },
  { key: "decoders", label: "Decoders", icon: "heroicons:cpu-chip" },
];

export default function WallManagement() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can("vms.wall.manage");
  const canView = can("vms.wall.view");

  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("monitors");
  const [wallModal, setWallModal] = useState(null); // { wall } | { }
  const [monitorModal, setMonitorModal] = useState(null);
  const [decoderModal, setDecoderModal] = useState(null);
  const [tourModal, setTourModal] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const wallsQ = useQuery({
    queryKey: ["walls"],
    queryFn: () => videowall.walls.list({ limit: 200 }),
    enabled: canView,
  });
  const walls = useMemo(() => asItems(wallsQ.data), [wallsQ.data]);
  const selected = useMemo(() => walls.find((w) => w.id === selectedId) || null, [walls, selectedId]);

  // Decoders are wall-independent (tenant-scoped catalog) — used across the
  // Decoders tab and the monitor form. Gracefully empty if VW-B isn't live.
  const decodersQ = useQuery({
    queryKey: ["wall-decoders"],
    queryFn: () => videowall.decoders.list().catch(() => ({ items: [] })),
    enabled: canView,
  });
  const decoders = useMemo(() => asItems(decodersQ.data), [decodersQ.data]);

  if (!canView) {
    return <EmptyState icon="heroicons-outline:lock-closed" title="No access" subtitle="You don't have permission to view video walls." />;
  }

  const refetchWalls = () => qc.invalidateQueries({ queryKey: ["walls"] });

  // ── wall CRUD ──────────────────────────────────────────────────────────
  const submitWall = async (body) => {
    setBusy(true);
    try {
      if (wallModal?.wall) {
        await videowall.walls.update(wallModal.wall.id, body);
        toast.success("Wall updated");
      } else {
        const created = await videowall.walls.create(body);
        toast.success("Wall created");
        setSelectedId(created?.id || null);
      }
      setWallModal(null);
      refetchWalls();
    } catch (e) {
      toast.error(apiError(e, "Could not save the wall"));
    } finally {
      setBusy(false);
    }
  };

  const deleteWall = (wall) =>
    setConfirm({
      title: "Delete wall",
      message: `Delete “${wall.name}” and its monitors, presets and tours? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await videowall.walls.remove(wall.id);
          toast.success("Wall deleted");
          if (selectedId === wall.id) setSelectedId(null);
          refetchWalls();
        } catch (e) {
          toast.error(apiError(e, "Could not delete the wall"));
        }
        setConfirm(null);
      },
    });

  return (
    <div>
      <PageHeader
        title="Video wall management"
        subtitle="Shared control-room display surfaces — walls, monitors, presets, tours and decoders."
        actions={
          <>
            <Link href="/wall">
              <Button variant="secondary" icon="heroicons-outline:play">
                Open console
              </Button>
            </Link>
            {canManage && (
              <Button variant="primary" icon="heroicons-mini:plus" onClick={() => setWallModal({})}>
                New wall
              </Button>
            )}
          </>
        }
      />

      <MasterDetail
        aside={
          <ListPanel title="Walls" count={walls.length}>
            {wallsQ.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
                <Spinner /> Loading…
              </div>
            ) : walls.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-muted">No walls yet.</div>
            ) : (
              <ul className="p-2">
                {walls.map((w) => (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(w.id)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition ${
                        selectedId === w.id ? "bg-hover" : "hover:bg-hover"
                      }`}
                    >
                      <Icon icon="heroicons:computer-desktop" className={`text-base ${selectedId === w.id ? "text-blue-500" : "text-muted"}`} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium text-foreground">{w.name}</span>
                        <span className="text-[11px] text-muted">
                          {w.rows}×{w.cols}
                          {!w.is_active && " · inactive"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ListPanel>
        }
      >
        {selected ? (
          <WallDetail
            wall={selected}
            tab={tab}
            setTab={setTab}
            canManage={canManage}
            decoders={decoders}
            decodersLoading={decodersQ.isLoading}
            onEditWall={() => setWallModal({ wall: selected })}
            onDeleteWall={() => deleteWall(selected)}
            onAddMonitor={() => setMonitorModal({ wallId: selected.id })}
            onEditMonitor={(m) => setMonitorModal({ wallId: selected.id, monitor: m })}
            onAddTour={() => setTourModal({ wallId: selected.id })}
            onEditTour={(t) => setTourModal({ wallId: selected.id, tour: t })}
            onAddDecoder={() => setDecoderModal({})}
            onEditDecoder={(d) => setDecoderModal({ decoder: d })}
            setConfirm={setConfirm}
            refetchDecoders={() => qc.invalidateQueries({ queryKey: ["wall-decoders"] })}
          />
        ) : (
          <EmptyDetail icon="heroicons:computer-desktop" title="Select a wall" subtitle="Pick a wall to manage its monitors, presets and tours." />
        )}
      </MasterDetail>

      {/* Modals */}
      <WallFormModal open={!!wallModal} wall={wallModal?.wall} onClose={() => setWallModal(null)} onSubmit={submitWall} busy={busy} />

      <MonitorFormModal
        open={!!monitorModal}
        monitor={monitorModal?.monitor}
        decoders={decoders}
        defaultPosition={selected ? (asItems(qc.getQueryData(["wall-monitors", selected.id]))?.length || 0) : 0}
        onClose={() => setMonitorModal(null)}
        busy={busy}
        onSubmit={async (body) => {
          setBusy(true);
          try {
            if (monitorModal.monitor) await videowall.monitors.update(monitorModal.wallId, monitorModal.monitor.id, body);
            else await videowall.monitors.create(monitorModal.wallId, body);
            toast.success("Monitor saved");
            setMonitorModal(null);
            qc.invalidateQueries({ queryKey: ["wall-monitors", monitorModal.wallId] });
          } catch (e) {
            toast.error(apiError(e, "Could not save the monitor"));
          } finally {
            setBusy(false);
          }
        }}
      />

      <DecoderFormModal
        open={!!decoderModal}
        decoder={decoderModal?.decoder}
        onClose={() => setDecoderModal(null)}
        busy={busy}
        onSubmit={async (body) => {
          setBusy(true);
          try {
            if (decoderModal.decoder) await videowall.decoders.update(decoderModal.decoder.id, body);
            else await videowall.decoders.create(body);
            toast.success("Decoder saved");
            setDecoderModal(null);
            qc.invalidateQueries({ queryKey: ["wall-decoders"] });
          } catch (e) {
            const status = e?.response?.status;
            toast.error(
              status === 404
                ? "Decoder API isn't available yet (VW-B pending)."
                : apiError(e, "Could not save the decoder"),
            );
          } finally {
            setBusy(false);
          }
        }}
      />

      <TourFormModal
        open={!!tourModal}
        tour={tourModal?.tour}
        presets={tourModal ? asItems(qc.getQueryData(["wall-presets", tourModal.wallId])) : []}
        onClose={() => setTourModal(null)}
        busy={busy}
        onSubmit={async (body) => {
          setBusy(true);
          try {
            if (tourModal.tour) await videowall.tours.update(tourModal.wallId, tourModal.tour.id, body);
            else await videowall.tours.create(tourModal.wallId, body);
            toast.success("Tour saved");
            setTourModal(null);
            qc.invalidateQueries({ queryKey: ["wall-tours", tourModal.wallId] });
          } catch (e) {
            toast.error(apiError(e, "Could not save the tour"));
          } finally {
            setBusy(false);
          }
        }}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ── Wall detail (tabbed) ────────────────────────────────────────────────────
function WallDetail({
  wall,
  tab,
  setTab,
  canManage,
  decoders,
  decodersLoading,
  onEditWall,
  onDeleteWall,
  onAddMonitor,
  onEditMonitor,
  onAddTour,
  onEditTour,
  onAddDecoder,
  onEditDecoder,
  setConfirm,
  refetchDecoders,
}) {
  const qc = useQueryClient();

  const monitorsQ = useQuery({ queryKey: ["wall-monitors", wall.id], queryFn: () => videowall.monitors.list(wall.id) });
  const presetsQ = useQuery({ queryKey: ["wall-presets", wall.id], queryFn: () => videowall.presets.list(wall.id) });
  const toursQ = useQuery({ queryKey: ["wall-tours", wall.id], queryFn: () => videowall.tours.list(wall.id) });

  const monitors = useMemo(() => sortedMonitors(asItems(monitorsQ.data)), [monitorsQ.data]);
  const presets = useMemo(() => asItems(presetsQ.data), [presetsQ.data]);
  const tours = useMemo(() => asItems(toursQ.data), [toursQ.data]);
  const decoderById = useMemo(() => new Map(decoders.map((d) => [d.id, d])), [decoders]);

  const delMonitor = (m) =>
    setConfirm({
      title: "Remove monitor",
      message: `Remove “${m.name}” from this wall?`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        try {
          await videowall.monitors.remove(wall.id, m.id);
          toast.success("Monitor removed");
          qc.invalidateQueries({ queryKey: ["wall-monitors", wall.id] });
        } catch (e) {
          toast.error(apiError(e, "Could not remove the monitor"));
        }
        setConfirm(null);
      },
    });

  const delPreset = (p) =>
    setConfirm({
      title: "Delete preset",
      message: `Delete preset “${p.name}”?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await videowall.presets.remove(wall.id, p.id);
          toast.success("Preset deleted");
          qc.invalidateQueries({ queryKey: ["wall-presets", wall.id] });
        } catch (e) {
          toast.error(apiError(e, "Could not delete the preset"));
        }
        setConfirm(null);
      },
    });

  const delTour = (t) =>
    setConfirm({
      title: "Delete tour",
      message: `Delete tour “${t.name}”?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await videowall.tours.remove(wall.id, t.id);
          toast.success("Tour deleted");
          qc.invalidateQueries({ queryKey: ["wall-tours", wall.id] });
        } catch (e) {
          toast.error(apiError(e, "Could not delete the tour"));
        }
        setConfirm(null);
      },
    });

  const testDecoder = async (d) => {
    const t = toast.loading(`Probing “${d.name}”…`);
    try {
      const r = await videowall.decoders.test(d.id);
      toast.dismiss(t);
      if (r?.reachable) {
        toast.success(`${d.name} reachable${r.model ? ` · ${r.manufacturer || ""} ${r.model}` : ""}`);
      } else {
        toast.error(`${d.name} unreachable${r?.error ? `: ${r.error}` : ""}`);
      }
    } catch (e) {
      toast.dismiss(t);
      toast.error(apiError(e, "Could not probe the decoder"));
    }
  };

  const delDecoder = (d) =>
    setConfirm({
      title: "Delete decoder",
      message: `Delete decoder “${d.name}”?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        try {
          await videowall.decoders.remove(d.id);
          toast.success("Decoder deleted");
          refetchDecoders();
        } catch (e) {
          toast.error(apiError(e, "Could not delete the decoder"));
        }
        setConfirm(null);
      },
    });

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-card-border bg-card">
      {/* Detail header */}
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-card-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-base font-semibold text-foreground">{wall.name}</h2>
            {!wall.is_active && <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">inactive</span>}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {wall.rows}×{wall.cols} monitor grid{wall.description ? ` · ${wall.description}` : ""}
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" icon="heroicons-outline:pencil-square" onClick={onEditWall}>
              Edit
            </Button>
            <Button variant="ghost" icon="heroicons-outline:trash" onClick={onDeleteWall} className="text-red-400 hover:text-red-500">
              Delete
            </Button>
          </div>
        )}
      </header>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-card-border px-3 pt-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition ${
              tab === t.key ? "border-b-2 border-blue-500 text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            <Icon icon={t.icon} className="text-sm" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {tab === "monitors" && (
          <TabList
            loading={monitorsQ.isLoading}
            items={monitors}
            emptyIcon="heroicons:computer-desktop"
            emptyText="No monitors — add the screens that make up this wall."
            addLabel="Add monitor"
            canManage={canManage}
            onAdd={onAddMonitor}
            renderRow={(m) => {
              const cap = monitorGrid(m.layout).capacity;
              const isDecoder = m.kind === "decoder";
              return (
                <>
                  <Icon icon={isDecoder ? "heroicons:cpu-chip" : "heroicons:computer-desktop"} className={`text-base ${isDecoder ? "text-amber-400" : "text-muted"}`} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium text-foreground">{m.name}</span>
                    <span className="text-[11px] text-muted">
                      slot {m.position} · {cap === 1 ? "single" : `${cap} cells`} · {isDecoder ? `decoder${m.decoder_id ? `: ${decoderById.get(m.decoder_id)?.name || "?"} ch${m.decoder_channel}` : ""}` : "browser"}
                    </span>
                  </span>
                </>
              );
            }}
            onEdit={onEditMonitor}
            onDelete={delMonitor}
          />
        )}

        {tab === "presets" && (
          <TabList
            loading={presetsQ.isLoading}
            items={presets}
            emptyIcon="heroicons-outline:bookmark"
            emptyText="No presets — save one from the operator console (arrange the wall, then Save current)."
            canManage={canManage}
            renderRow={(p) => (
              <>
                <Icon icon="heroicons-outline:bookmark" className="text-base text-muted" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{p.name}</span>
                  <span className="text-[11px] text-muted">
                    {Object.values(p.state || {}).reduce((n, mon) => n + Object.values(mon || {}).filter(Boolean).length, 0)} cameras
                    {p.is_default ? " · default" : ""}
                  </span>
                </span>
              </>
            )}
            onDelete={delPreset}
          />
        )}

        {tab === "tours" && (
          <TabList
            loading={toursQ.isLoading}
            items={tours}
            emptyIcon="heroicons-outline:arrow-path-rounded-square"
            emptyText="No tours — cycle a sequence of presets on a dwell interval."
            addLabel="New tour"
            canManage={canManage}
            onAdd={onAddTour}
            renderRow={(t) => (
              <>
                <Icon icon="heroicons-outline:arrow-path-rounded-square" className={`text-base ${t.is_running ? "text-blue-500" : "text-muted"}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {t.name}
                    {t.is_running && <span className="ml-1.5 rounded bg-blue-500/10 px-1 text-[9px] font-semibold text-blue-500">RUNNING</span>}
                  </span>
                  <span className="text-[11px] text-muted">
                    {(t.preset_ids || []).length} presets · {t.dwell_seconds}s dwell
                  </span>
                </span>
              </>
            )}
            onEdit={onEditTour}
            onDelete={delTour}
          />
        )}

        {tab === "decoders" && (
          <TabList
            loading={decodersLoading}
            items={decoders}
            emptyIcon="heroicons:cpu-chip"
            emptyText="No decoders registered. Decoder push is VW-B — register hardware decoders here to route streams to physical outputs."
            addLabel="Register decoder"
            canManage={canManage}
            onAdd={onAddDecoder}
            renderRow={(d) => (
              <>
                <Icon icon="heroicons:cpu-chip" className={`text-base ${d.is_enabled ? "text-amber-400" : "text-muted"}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{d.name}</span>
                  <span className="text-[11px] text-muted">
                    {DECODER_BRANDS.find((b) => b.value === d.brand)?.label || d.brand} · {d.host}:{d.port} · {d.channel_count} ch
                    {d.is_enabled ? "" : " · disabled"}
                  </span>
                </span>
              </>
            )}
            onEdit={onEditDecoder}
            onDelete={delDecoder}
            extraAction={(d) => (
              <button
                type="button"
                title="Test connection"
                onClick={() => testDecoder(d)}
                className="rounded p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:signal" className="text-sm" />
              </button>
            )}
          />
        )}
      </div>
    </section>
  );
}

// A simple add-button + row-list with edit/delete actions, shared by all tabs.
function TabList({ loading, items, emptyIcon, emptyText, addLabel, canManage, onAdd, renderRow, onEdit, onDelete, extraAction }) {
  return (
    <div>
      {canManage && onAdd && (
        <div className="mb-3 flex justify-end">
          <Button variant="secondary" icon="heroicons-mini:plus" onClick={onAdd}>
            {addLabel}
          </Button>
        </div>
      )}
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted">
          <Spinner /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Icon icon={emptyIcon} className="text-2xl text-muted" />
          <p className="max-w-sm text-xs text-muted">{emptyText}</p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.id} className="flex items-center gap-2.5 rounded-lg border border-card-border bg-background/40 px-3 py-2">
              {renderRow(it)}
              {canManage && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {extraAction && extraAction(it)}
                  {onEdit && (
                    <button type="button" title="Edit" onClick={() => onEdit(it)} className="rounded p-1.5 text-muted transition hover:bg-hover hover:text-foreground">
                      <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
                    </button>
                  )}
                  {onDelete && (
                    <button type="button" title="Delete" onClick={() => onDelete(it)} className="rounded p-1.5 text-muted transition hover:bg-red-500/10 hover:text-red-400">
                      <Icon icon="heroicons-outline:trash" className="text-sm" />
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
