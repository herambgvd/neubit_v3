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
import StatusBadge, { StatusDot } from "./components/StatusBadge";
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
              <div className="flex items-center gap-1.5">
                <button onClick={invalidate} title="Refresh" className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[#22d3ee] hover:text-[#22d3ee]">
                  <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                </button>
                <button onClick={() => setAddOpen(true)} title="Add recorder" className="inline-flex h-7 items-center gap-1 rounded-[8px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] px-2.5 text-[12px] font-medium text-[#67e8f9] transition hover:border-[#22d3ee] hover:bg-[rgba(34,211,238,.25)]">
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[1.2px]">
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#34d399] shadow-[0_0_5px_#34d399]" /><span className="text-[#aec2e8]">{onlineCount} online</span></span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]" /><span className="text-[#7e93bf]">{nodes.length - onlineCount} offline</span></span>
            </div>

            {nodesQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base text-[#67e8f9]" />Loading…</div>
            ) : nodesQ.isError ? (
              <div className="px-4 py-6 text-center text-xs text-[#f87171]">{apiError(nodesQ.error, "Failed to load recorders")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#9a92c8]">{nodes.length === 0 ? "No recorders yet — click Add." : "No matches."}</div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((n) => {
                  const isSel = selectedId === n.id;
                  const used = n.used_channels ?? 0;
                  const cap = n.capacity_channels;
                  const pct = cap != null && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null;
                  const online = n.status === "online";
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={`relative block w-full overflow-hidden rounded-[13px] border px-3 py-2.5 text-left backdrop-blur-sm transition ${isSel ? "border-[#22d3ee] bg-[rgba(34,211,238,.08)] shadow-[0_0_0_1px_rgba(34,211,238,.4)]" : "border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] hover:border-[rgba(34,211,238,.5)] hover:bg-[rgba(34,211,238,.06)]"}`}
                    >
                      {isSel && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l bg-[#22d3ee]" />}
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-[#34d399] shadow-[0_0_5px_#34d399]" : "bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]"}`} />
                          <p className="truncate font-mono text-xs font-semibold text-[#f2f6ff]">{n.name}</p>
                        </span>
                        <StatusBadge status={n.status} />
                      </div>
                      {n.label && <p className="mt-0.5 truncate pl-3.5 text-[10px] text-[#9a92c8]">{n.label}</p>}
                      <p className="mt-0.5 pl-3.5 font-mono text-[10px] tabular-nums text-[#7e93bf]">
                        {used} / {cap != null ? cap : "∞"} channel(s)
                      </p>
                      {pct != null && (
                        <div className="ml-3.5 mt-1.5 h-[4px] overflow-hidden rounded-full border border-[rgba(150,180,245,.22)] bg-black/40">
                          <span className="block h-full rounded-full bg-gradient-to-r from-[#60a5fa] to-[#22d3ee]" style={{ width: `${pct}%` }} />
                        </div>
                      )}
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
function InfoCell({ label, value, mono = false, children }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[1.4px] text-[#9a92c8]">{label}</p>
      <p className={`mt-0.5 truncate text-[13px] font-medium text-[#f2f6ff] ${mono ? "font-mono" : ""}`} title={typeof value === "string" ? value : undefined}>{value ?? "—"}</p>
      {children}
    </div>
  );
}

function RecorderDetail({ node, onEdit, onDrain, onDelete }) {
  const cap = node.capacity_channels;

  // Cameras pinned to THIS recorder (client-side filter — the list API has no
  // media_node_id filter). Refetches so a fresh assignment shows up.
  const camsQ = useQuery({
    queryKey: ["vms-cameras", "for-recorder-detail"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 15_000,
  });
  const assigned = useMemo(
    () => asItems(camsQ.data).filter((c) => c.media_node_id === node.id),
    [camsQ.data, node.id],
  );
  // The true channel load is what we can actually count locally; fall back to the
  // server's reported used_channels when cameras are still loading.
  const used = camsQ.isSuccess ? assigned.length : node.used_channels ?? 0;
  const full = cap != null && used >= cap;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] backdrop-blur-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(160,150,245,.22)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.12)] text-[#67e8f9]">
            <Icon icon="heroicons:cpu-chip" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-mono text-base font-semibold text-[#f2f6ff]">{node.name}</h1>
            <p className="truncate font-mono text-[11px] text-[#9a92c8]">{node.api_url || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <Button variant="secondary" className="!px-2.5 !py-1.5 !text-xs" icon="heroicons-outline:pencil-square" onClick={() => onEdit?.(node)}>Edit</Button>
          {node.status !== "draining" && (
            <Button variant="ghost" className="!px-2 !py-1.5 !text-xs !text-[#fbbf24]" icon="heroicons-outline:arrow-down-tray" onClick={() => onDrain?.(node)}>Drain</Button>
          )}
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs !text-[#f87171]" icon="heroicons-outline:trash" onClick={() => onDelete?.(node)}>Delete</Button>
        </div>
      </div>

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={node.status || "unknown"} />
          <InfoCell
            label="Capacity"
            value={
              <span className={full ? "text-[#fbbf24]" : ""}>
                {used}
                <span className="text-[#7e93bf]"> / {cap != null ? cap : "∞"}</span>
              </span>
            }
          >
            {cap != null && cap > 0 && (
              <div className="mt-1.5 h-[5px] overflow-hidden rounded-full border border-[rgba(150,180,245,.22)] bg-black/40">
                <span
                  className={`block h-full rounded-full ${full ? "bg-gradient-to-r from-[#60a5fa] to-[#fbbf24]" : "bg-gradient-to-r from-[#60a5fa] to-[#22d3ee]"}`}
                  style={{ width: `${Math.min(100, Math.round((used / cap) * 100))}%` }}
                />
              </div>
            )}
          </InfoCell>
          <InfoCell label="Location / label" value={node.label || "—"} />
          <InfoCell label="Last heartbeat" value={node.last_heartbeat ? fmtRelative(node.last_heartbeat) : "—"} />
        </div>

        {/* Endpoints */}
        <p className="mb-2 mt-4 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Endpoints</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell label="API URL" value={node.api_url || "—"} mono />
          <InfoCell label="HLS base" value={node.hls_base || "—"} mono />
          <InfoCell label="WebRTC base" value={node.webrtc_base || "—"} mono />
          <InfoCell label="RTSP base" value={node.rtsp_base || "—"} mono />
        </div>

        {/* Assigned cameras — what this recorder actually records */}
        <div className="mb-2 mt-4 flex items-center justify-between">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Assigned cameras</p>
          <span className="rounded-full border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">{assigned.length}</span>
        </div>
        {camsQ.isLoading ? (
          <p className="px-1 py-3 text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-[#67e8f9]" />Loading…</p>
        ) : assigned.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-[rgba(160,150,245,.28)] px-3 py-4 text-center text-xs text-[#9a92c8]">
            No cameras pinned to this recorder yet. On the Cameras page, open a camera → Recording → Recorder and select “{node.name}”.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {assigned.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
                <StatusDot status={c.status} />
                {c.nvr_channel_number != null && (
                  <span className="flex h-5 min-w-[1.5rem] shrink-0 items-center justify-center rounded border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">
                    {c.nvr_channel_number}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#f2f6ff]" title={c.name}>{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.5px] text-[#7e93bf]">{c.status}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-[#7e93bf]">
          Cameras pinned to this recorder record to its local storage. Drain before deleting, then reassign its cameras to another recorder.
        </p>
      </div>
    </section>
  );
}
