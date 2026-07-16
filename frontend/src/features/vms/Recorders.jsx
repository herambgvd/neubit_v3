"use client";

// VMS → Recorders. The MediaNode registry: independent recorder machines (each its
// own MediaMTX + storage) that cameras are pinned to via `media_node_id`. A two-pane
// master/detail (LEFT = onboarded recorders list with search + Add + online counts,
// RIGHT = RecorderDetail with full info + Edit / Drain / Delete). Mirrors the NVR page
// exactly (MasterDetail + ListPanel + EmptyDetail, TanStack Query + invalidation,
// StatusBadge, sonner, ConfirmDialog). Add / edit reuse AddRecorderModal.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative } from "@/lib/format";
import { vms } from "./api";
import StatusBadge from "./components/StatusBadge";
import AddRecorderModal from "./components/AddRecorderModal";

export default function RecordersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const nodesQ = useQuery({
    queryKey: ["vms-media-nodes"],
    queryFn: () => vms.mediaNodes.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  const nodes = useMemo(() => asItems(nodesQ.data), [nodesQ.data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["vms-media-nodes"] });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return nodes;
    return nodes.filter(
      (n) =>
        n.name?.toLowerCase().includes(term) ||
        n.label?.toLowerCase().includes(term) ||
        n.api_url?.toLowerCase().includes(term),
    );
  }, [nodes, search]);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);

  // Auto-select first (mirrors NVR): keep selection across refetches; clear when gone.
  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const onlineCount = nodes.filter((n) => n.status === "online").length;

  const drain = useMutation({
    mutationFn: (id) => vms.mediaNodes.update(id, { status: "draining" }),
    onSuccess: () => { toast.success("Recorder set to draining"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Drain failed")),
  });

  const remove = useMutation({
    mutationFn: (id) => vms.mediaNodes.remove(id),
    onSuccess: (_d, id) => {
      toast.success("Recorder removed");
      if (selectedId === id) setSelectedId(null);
      invalidate();
    },
    // The backend blocks deletion while cameras are still assigned — surface it.
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDrain = (node) =>
    setConfirm({
      title: "Drain recorder",
      message: `Set ${node.name} to draining? New recordings stop landing here; reassign its cameras to another recorder before deleting.`,
      confirmLabel: "Drain",
      onConfirm: () => { drain.mutate(node.id); setConfirm(null); },
    });

  const askDelete = (node) =>
    setConfirm({
      title: "Delete recorder",
      message: `Remove ${node.name}? Cameras still assigned to it must be reassigned first — the backend will block this otherwise.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => { remove.mutate(node.id); setConfirm(null); },
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title="Recorders"
            icon="heroicons:cpu-chip"
            count={nodes.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name, label or URL…"
            action={
              <div className="flex items-center gap-1">
                <button onClick={invalidate} title="Refresh" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                  <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                </button>
                <button onClick={() => setAddOpen(true)} title="Add recorder" className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500">
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="text-muted">{onlineCount} online</span></span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-muted" /><span className="text-muted">{nodes.length - onlineCount} offline</span></span>
            </div>

            {nodesQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-muted"><Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />Loading…</div>
            ) : nodesQ.isError ? (
              <div className="px-4 py-6 text-center text-xs text-red-500">{apiError(nodesQ.error, "Failed to load recorders")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted">{nodes.length === 0 ? "No recorders yet — click Add." : "No matches."}</div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((n) => {
                  const isSel = selectedId === n.id;
                  const used = n.used_channels ?? 0;
                  const cap = n.capacity_channels;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={`relative block w-full rounded-lg border px-3 py-2.5 text-left transition ${isSel ? "border-foreground bg-hover" : "border-card-border hover:bg-hover"}`}
                    >
                      {isSel && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l bg-blue-500" />}
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-foreground">{n.name}</p>
                        <StatusBadge status={n.status} />
                      </div>
                      {n.label && <p className="mt-0.5 truncate text-[10px] text-muted">{n.label}</p>}
                      <p className="mt-0.5 text-[10px] text-muted/70 tabular-nums">
                        {used} / {cap != null ? cap : "∞"} channel(s)
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </ListPanel>
        }
      >
        {selected ? (
          <RecorderDetail
            key={selected.id}
            node={selected}
            onEdit={(n) => setEditTarget(n)}
            onDrain={askDrain}
            onDelete={askDelete}
          />
        ) : (
          <EmptyDetail icon="heroicons:cpu-chip" title="No recorder selected" subtitle="Choose a recorder to view its endpoints, capacity and health." />
        )}
      </MasterDetail>

      {addOpen && (
        <AddRecorderModal
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); invalidate(); }}
        />
      )}
      {editTarget && (
        <AddRecorderModal
          node={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => { setEditTarget(null); invalidate(); }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={drain.isPending || remove.isPending} />
    </div>
  );
}

// Right-pane detail for one recorder (MediaNode): header (name / label / status +
// Edit / Drain / Delete) + an info grid (endpoints, capacity, heartbeat). Mirrors
// NvrDetail's card chrome so the three device pages look identical.
function InfoCell({ label, value, mono = false }) {
  return (
    <div className="min-w-0 rounded-lg border border-card-border bg-hover/40 px-3 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-0.5 truncate text-[13px] font-medium text-foreground ${mono ? "font-mono" : ""}`} title={typeof value === "string" ? value : undefined}>{value ?? "—"}</p>
    </div>
  );
}

function RecorderDetail({ node, onEdit, onDrain, onDelete }) {
  const used = node.used_channels ?? 0;
  const cap = node.capacity_channels;
  const full = cap != null && used >= cap;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
            <Icon icon="heroicons:cpu-chip" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">{node.name}</h1>
            <p className="truncate font-mono text-[11px] text-muted">{node.api_url || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <Button variant="secondary" className="!px-2.5 !py-1.5 !text-xs" icon="heroicons-outline:pencil-square" onClick={() => onEdit?.(node)}>Edit</Button>
          {node.status !== "draining" && (
            <Button variant="ghost" className="!px-2 !py-1.5 !text-xs !text-amber-500" icon="heroicons-outline:arrow-down-tray" onClick={() => onDrain?.(node)}>Drain</Button>
          )}
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs !text-red-500" icon="heroicons-outline:trash" onClick={() => onDelete?.(node)}>Delete</Button>
        </div>
      </div>

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={node.status || "unknown"} />
          <InfoCell
            label="Capacity"
            value={
              <span className={full ? "text-amber-500" : ""}>
                {used}
                <span className="text-muted"> / {cap != null ? cap : "∞"}</span>
              </span>
            }
          />
          <InfoCell label="Location / label" value={node.label || "—"} />
          <InfoCell label="Last heartbeat" value={node.last_heartbeat ? fmtRelative(node.last_heartbeat) : "—"} />
        </div>

        {/* Endpoints */}
        <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted">Endpoints</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell label="API URL" value={node.api_url || "—"} mono />
          <InfoCell label="HLS base" value={node.hls_base || "—"} mono />
          <InfoCell label="WebRTC base" value={node.webrtc_base || "—"} mono />
          <InfoCell label="RTSP base" value={node.rtsp_base || "—"} mono />
        </div>

        <p className="mt-3 text-[11px] text-muted">
          Cameras pinned to this recorder record to its local storage. Drain before deleting, then reassign its cameras to another recorder.
        </p>
      </div>
    </section>
  );
}
