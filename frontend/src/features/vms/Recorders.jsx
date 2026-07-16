"use client";

// VMS → Recorders. The MediaNode registry: independent recorder machines (each its
// own MediaMTX + storage) that cameras are pinned to via `media_node_id`. A flat
// management table (name · location · api_url · status · capacity · heartbeat) with
// Add / Edit / Drain / Delete. Mirrors the NVR page's conventions (TanStack Query +
// invalidation, StatusBadge, sonner, ConfirmDialog) but table-first via DataTable.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, EmptyState } from "@/components/ui/kit";
import { DataTable } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative } from "@/lib/format";
import { vms } from "./api";
import StatusBadge from "./components/StatusBadge";
import AddRecorderModal from "./components/AddRecorderModal";

export default function RecordersPage() {
  const qc = useQueryClient();
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

  const onlineCount = nodes.filter((n) => n.status === "online").length;

  const drain = useMutation({
    mutationFn: (id) => vms.mediaNodes.update(id, { status: "draining" }),
    onSuccess: () => { toast.success("Recorder set to draining"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Drain failed")),
  });

  const remove = useMutation({
    mutationFn: (id) => vms.mediaNodes.remove(id),
    onSuccess: () => { toast.success("Recorder removed"); invalidate(); },
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

  const columns = useMemo(
    () => [
      {
        id: "name",
        header: "Recorder",
        accessorFn: (n) => n.name || "",
        cell: ({ row }) => {
          const n = row.original;
          return (
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-foreground">{n.name}</p>
              {n.label ? <p className="mt-0.5 truncate text-[11px] text-muted">{n.label}</p> : null}
            </div>
          );
        },
      },
      {
        id: "api_url",
        header: "API URL",
        accessorFn: (n) => n.api_url || "",
        cell: ({ getValue }) => (
          <span className="truncate font-mono text-[11px] text-muted">{getValue() || "—"}</span>
        ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (n) => n.status || "unknown",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        id: "capacity",
        header: "Capacity",
        meta: { align: "right" },
        accessorFn: (n) => n.used_channels ?? 0,
        cell: ({ row }) => {
          const n = row.original;
          const used = n.used_channels ?? 0;
          const cap = n.capacity_channels;
          const full = cap != null && used >= cap;
          return (
            <span className={`tabular-nums text-[12px] ${full ? "font-semibold text-amber-500" : "text-foreground"}`}>
              {used}
              <span className="text-muted"> / {cap != null ? cap : "∞"}</span>
            </span>
          );
        },
      },
      {
        id: "heartbeat",
        header: "Last heartbeat",
        meta: { align: "right" },
        accessorFn: (n) => n.last_heartbeat || "",
        cell: ({ getValue }) => (
          <span className="tabular-nums text-[12px] text-muted">{fmtRelative(getValue())}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { align: "right", cellClassName: "px-4 py-2 text-right" },
        cell: ({ row }) => {
          const n = row.original;
          return (
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); setEditTarget(n); }}
                title="Edit"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
              </button>
              {n.status !== "draining" && (
                <button
                  onClick={(e) => { e.stopPropagation(); askDrain(n); }}
                  title="Drain"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-amber-500 hover:bg-hover"
                >
                  <Icon icon="heroicons-outline:arrow-down-tray" className="text-sm" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); askDelete(n); }}
                title="Delete"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-500 hover:bg-hover"
              >
                <Icon icon="heroicons-outline:trash" className="text-sm" />
              </button>
            </div>
          );
        },
      },
    ],
    [], // handlers are stable module-scope closures over setState — safe to memo once
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Icon icon="heroicons:cpu-chip" className="text-base text-muted" />
            <span className="text-sm font-semibold text-foreground">Recorders</span>
            <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">{nodes.length}</span>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 text-muted"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />{onlineCount} online</span>
            <span className="flex items-center gap-1 text-muted"><span className="h-1.5 w-1.5 rounded-full bg-muted" />{nodes.length - onlineCount} offline</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={invalidate}
            title="Refresh"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
          </button>
          <Button variant="success" icon="heroicons-mini:plus" onClick={() => setAddOpen(true)}>
            Add recorder
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodesQ.isLoading ? (
          <div className="px-4 py-10 text-center text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />Loading…
          </div>
        ) : nodesQ.isError ? (
          <div className="px-4 py-10 text-center text-xs text-red-500">{apiError(nodesQ.error, "Failed to load recorders")}</div>
        ) : (
          <DataTable
            columns={columns}
            data={nodes}
            getRowId={(n) => n.id}
            initialSorting={[{ id: "name", desc: false }]}
            emptyState={
              <EmptyState
                icon="heroicons:cpu-chip"
                title="No recorders yet"
                subtitle="Add a recorder machine — cameras can then be pinned to it. Unassigned cameras record on the default node."
                action={<Button variant="success" icon="heroicons-mini:plus" onClick={() => setAddOpen(true)}>Add recorder</Button>}
              />
            }
          />
        )}
      </div>

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
