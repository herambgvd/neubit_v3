"use client";

// VMS → Recorders. The MediaNode registry: independent recorder machines (each its
// own MediaMTX + storage) that cameras are pinned to via `media_node_id`. A two-pane
// master/detail (LEFT = onboarded recorders list with search + Add + online counts,
// RIGHT = RecorderDetail with full info + Edit / Drain / Delete). Mirrors the NVR page
// exactly (MasterDetail + ListPanel + EmptyDetail, TanStack Query + invalidation,
// StatusBadge, sonner, ConfirmDialog). Add / edit reuse AddRecorderModal.
import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Modal, type ConfirmState } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail, Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { vms } from "./api";
import type { MediaNodePublic, NodeEnrollResult } from "./types";
import StatusBadge, { StatusDot } from "./components/StatusBadge";
import AddRecorderModal from "./components/AddRecorderModal";

export default function RecordersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<MediaNodePublic | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const nodesQ = useQuery({
    queryKey: ["vms-media-nodes"],
    queryFn: () => vms.mediaNodes.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  // Read the envelope directly: the query is typed, so `.items` is already
  // MediaNodePublic[]. `asItems(data)` widened the not-yet-loaded case to never[].
  const nodes = useMemo(() => nodesQ.data?.items ?? [], [nodesQ.data]);

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

  // The explicit choice, or the first row when there is none. Derived here
  // rather than synced by an effect, which rendered one frame with nothing
  // selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;

  const selected = useMemo(() => nodes.find((n) => n.id === effectiveId) || null, [nodes, effectiveId]);

  // Auto-select first (mirrors NVR): keep selection across refetches; clear when gone.

  const onlineCount = nodes.filter((n) => n.status === "online").length;

  const drain = useMutation({
    mutationFn: (id: string) => vms.mediaNodes.update(id, { status: "draining" }),
    onSuccess: () => { toast.success("Recorder set to draining"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Drain failed")),
  });

  const remove = useMutation({
    mutationFn: (id: string) => vms.mediaNodes.remove(id),
    onSuccess: (_d, id) => {
      toast.success("Recorder removed");
      if (effectiveId === id) setSelectedId(null);
      invalidate();
    },
    // The backend blocks deletion while cameras are still assigned — surface it.
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDrain = (node: MediaNodePublic) =>
    setConfirm({
      title: "Drain recorder",
      message: `Set ${node.name} to draining? New recordings stop landing here; reassign its cameras to another recorder before deleting.`,
      confirmLabel: "Drain",
      onConfirm: () => { drain.mutate(node.id); setConfirm(null); },
    });

  const askDelete = (node: MediaNodePublic) =>
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
        gridCols="lg:grid-cols-[25%_1fr]"
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
                {/* Icon only, like every other create in the console. A labelled
                    "+ Add" here and a bare plus on Sites is the same action
                    wearing two faces. */}
                <button
                  onClick={() => setAddOpen(true)}
                  title="New recorder"
                  aria-label="New recorder"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] text-[#67e8f9] transition hover:border-[#22d3ee] hover:bg-[rgba(34,211,238,.25)]"
                >
                  <Icon icon="heroicons:plus" className="text-sm" />
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
              <div className="px-4 py-6 text-center text-xs text-[#9a92c8]">{nodes.length === 0 ? "No recorders yet — use ＋ above." : "No matches."}</div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((n) => {
                  const isSel = effectiveId === n.id;
                  const used = n.used_channels ?? 0;
                  const cap = n.capacity_channels;
                  const pct = cap != null && cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : null;
                  const online = n.status === "online";
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={`relative block w-full overflow-hidden rounded-[13px] border px-3 py-2.5 text-left backdrop-blur-xs transition ${isSel ? "border-[#22d3ee] bg-[rgba(34,211,238,.08)] shadow-[0_0_0_1px_rgba(34,211,238,.4)]" : "border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] hover:border-[rgba(34,211,238,.5)] hover:bg-[rgba(34,211,238,.06)]"}`}
                    >
                      {isSel && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l-sm bg-[#22d3ee]" />}
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? "bg-[#34d399] shadow-[0_0_5px_#34d399]" : "bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]"}`} />
                          <p className="truncate font-mono text-xs font-semibold text-[#f2f6ff]">{n.name}</p>
                        </span>
                        <StatusBadge status={n.status} />
                      </div>
                      {/* A stale credential is the failure `status` cannot show: the
                          recorder is reachable and reports online, and everything
                          that needs the missing grant quietly errors. It gets its own
                          mark for that reason — an operator scanning this list would
                          otherwise see a healthy node. */}
                      {n.credential_error && (
                        <p className="mt-0.5 flex items-center gap-1 pl-3.5 text-[10px] text-[#fbbf24]">
                          <Icon icon="heroicons-outline:key" className="shrink-0 text-[11px]" />
                          Credential needs re-enrolling
                        </p>
                      )}
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
interface InfoCellProps {
  label: ReactNode;
  value?: ReactNode;
  mono?: boolean;
  children?: ReactNode;
}

function InfoCell({ label, value, mono = false, children }: InfoCellProps) {
  return (
    <div className="min-w-0 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[1.4px] text-[#9a92c8]">{label}</p>
      <p className={`mt-0.5 truncate text-[13px] font-medium text-[#f2f6ff] ${mono ? "font-mono" : ""}`} title={typeof value === "string" ? value : undefined}>{value ?? "—"}</p>
      {children}
    </div>
  );
}

interface RecorderDetailProps {
  node: MediaNodePublic;
  onEdit?: (node: MediaNodePublic) => void;
  onDrain?: (node: MediaNodePublic) => void;
  onDelete?: (node: MediaNodePublic) => void;
}

function RecorderDetail({ node, onEdit, onDrain, onDelete }: RecorderDetailProps) {
  const cap = node.capacity_channels;

  // THE RECORDER OWNS ITS CAMERAS. This pane used to list only VMS-owned rows
  // pinned to the node (`media_node_id`), and on a single-ownership estate — the
  // normal one, where the VMS onboards nothing — there are none. So a recorder
  // running three cameras read "0 / 128, no cameras pinned to this recorder yet"
  // here while Federation, one click away, listed all three. Same box, two
  // numbers, and this one was wrong.
  //
  // The recorder's own cameras come from the federation aggregate, which is the
  // node's answer about itself. Local pinned rows are still merged in: a
  // deployment that predates single ownership has them, and they are cameras the
  // VMS believes record here.
  const fedQ = useQuery({
    // The SAME key the Federation console uses, so the two screens share one
    // copy and cannot disagree about what a recorder is running.
    queryKey: ["vms-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    staleTime: 15_000,
  });
  const camsQ = useQuery({
    queryKey: ["vms-cameras", "for-recorder-detail"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 15_000,
  });

  const cameras = useMemo(() => {
    const owned = (fedQ.data?.items || [])
      .filter((c) => c.node_id === node.id)
      .map((c) => ({ id: c.id, name: c.name, status: String(c.status || "unknown"), channel: null as number | null }));
    const seen = new Set(owned.map((c) => c.id));
    const local = asItems(camsQ.data)
      .filter((c) => c.media_node_id === node.id && !seen.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: String(c.status || "unknown"),
        channel: c.nvr_channel_number ?? null,
      }));
    return [...owned, ...local];
  }, [fedQ.data, camsQ.data, node.id]);

  // The recorder is unreachable when the aggregate says so — its cameras cannot
  // be listed then, and an empty list must not read as "this recorder runs none".
  const nodeUnreachable = (fedQ.data?.unreachable || []).some((u) => u.node_id === node.id);
  const camsLoading = fedQ.isLoading || camsQ.isLoading;

  // Count what we can actually see; fall back to the heartbeat's own figure while
  // the lists load or when the node is not answering.
  const used = !camsLoading && !nodeUnreachable ? cameras.length : node.used_channels ?? 0;
  const full = cap != null && used >= cap;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] backdrop-blur-xs">
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
        {/* The recorder's own words, first, when it is refusing us.
            A federation credential keeps the grants it was minted with, so widening
            the recorder's grant set leaves an existing credential short — and the
            node stays online throughout. The message names the missing permission and
            the remedy; Re-enroll below is that remedy. */}
        {node.credential_error && (
          <div className="mb-3 flex items-start gap-2 rounded-[10px] border border-[rgba(251,191,36,.35)] bg-[rgba(251,191,36,.08)] px-3 py-2.5">
            <Icon icon="heroicons-outline:key" className="mt-0.5 shrink-0 text-sm text-[#fbbf24]" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#fbbf24]">This recorder is refusing our credential</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[#d6c99a]">{node.credential_error}</p>
            </div>
          </div>
        )}

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

        {/* NO endpoint list. They are set in Edit and read nowhere else here —
            four rows of internal URLs on a detail pane is reference material, not
            something an operator acts on. The API URL is already under the name. */}

        {/* Cameras — what this recorder actually runs, as the recorder reports it */}
        <div className="mb-2 mt-4 flex items-center justify-between">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Cameras</p>
          <span className="rounded-full border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">{cameras.length}</span>
        </div>
        {camsLoading ? (
          <p className="px-1 py-3 text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-[#67e8f9]" />Loading…</p>
        ) : nodeUnreachable ? (
          // An empty list here would say the recorder runs nothing, which is a
          // different claim from "it is not answering right now".
          <p className="rounded-[10px] border border-dashed border-[rgba(251,191,36,.35)] px-3 py-4 text-center text-xs text-[#fbbf24]">
            This recorder is not answering, so its cameras cannot be listed.
          </p>
        ) : cameras.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-[rgba(160,150,245,.28)] px-3 py-4 text-center text-xs text-[#9a92c8]">
            This recorder runs no cameras yet. Cameras are onboarded on the recorder itself.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {cameras.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
                <StatusDot status={c.status} />
                {c.channel != null && (
                  <span className="flex h-5 min-w-[1.5rem] shrink-0 items-center justify-center rounded-sm border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">
                    {c.channel}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#f2f6ff]" title={c.name}>{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.5px] text-[#7e93bf]">{c.status}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-[#7e93bf]">
          These cameras record to this recorder&apos;s own storage. Drain it before deleting, so its
          footage and channels are dealt with first.
        </p>

        {/* Federation trust — the credentials that let the VMS read + stream THROUGH
            this recorder (single ownership: the node owns its cameras/storage). */}
        <FederationTrust node={node} />
      </div>
    </section>
  );
}

// Federation trust / credentials for one recorder node. Shows enrollment status,
// lists issued credentials (grants + activity), lets an operator Enroll / Re-enroll
// (the RAW secret is shown ONCE, copyable, with a warning) and Revoke a credential.
// Gated on vms.config.manage, like the other recorder mutations.
function FederationTrust({ node }: { node: MediaNodePublic }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can("vms.config.manage");
  const [issued, setIssued] = useState<NodeEnrollResult | null>(null); // the just-issued RAW credential (show once)
  const [copied, setCopied] = useState(false);
  const [pairCode, setPairCode] = useState<string | null>(null); // non-null while the pair dialog is open
  const [confirm, setConfirm] = useState<ConfirmState | null>(null); // revoke confirmation

  const credsQ = useQuery({
    queryKey: ["vms-node-credentials", node.id],
    queryFn: () => vms.mediaNodes.credentials(node.id),
  });
  // Typed envelope — see the note on `nodes` above.
  const creds = useMemo(() => credsQ.data?.items ?? [], [credsQ.data]);
  const activeCount = creds.filter((c) => !c.revoked_at).length;
  const enrolled = node.has_credential || activeCount > 0;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["vms-node-credentials", node.id] });
    qc.invalidateQueries({ queryKey: ["vms-media-nodes"] });
  };

  const enroll = useMutation({
    mutationFn: () => vms.mediaNodes.enroll(node.id),
    onSuccess: (data) => {
      setIssued(data);
      setCopied(false);
      toast.success("Federation credential issued");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Enroll failed")),
  });

  // Pairing is the bootstrap for a recorder deployed on its OWN box: it has its own
  // VE_JWT_SECRET, so the shared-secret enrol above cannot authenticate to it. The
  // operator mints a one-use code on that recorder's console and enters it here.
  const pair = useMutation({
    mutationFn: () => vms.mediaNodes.pair(node.id, (pairCode ?? "").trim()),
    onSuccess: (data) => {
      setPairCode(null);
      setIssued(data);
      setCopied(false);
      toast.success("Paired — federation credential stored");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Pairing failed")),
  });

  const revoke = useMutation({
    mutationFn: (credId: string) => vms.mediaNodes.revokeCredential(node.id, credId),
    onSuccess: () => { toast.success("Credential revoked"); invalidate(); },
    onError: (e) => toast.error(apiError(e, "Revoke failed")),
  });

  // Only reachable from the credential modal, which renders while `issued` is set.
  const copyRaw = async () => {
    try {
      await navigator.clipboard.writeText(issued?.credential ?? "");
      setCopied(true);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  };

  return (
    <>
      <div className="mb-2 mt-5 flex items-center justify-between">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Federation trust</p>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
            enrolled
              ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.1)] text-[#34d399]"
              : "border-[rgba(160,150,245,.28)] bg-[rgba(150,180,245,.06)] text-[#9a92c8]"
          }`}
        >
          <Icon icon={enrolled ? "heroicons-outline:shield-check" : "heroicons-outline:shield-exclamation"} className="text-[11px]" />
          {enrolled ? "Enrolled" : "Not enrolled"}
        </span>
      </div>

      {/* No explainer paragraph. The Enrolled badge says the state and the two
          buttons below say the two ways to change it; a paragraph restating both
          is read once and skipped forever after. */}
      {credsQ.isLoading ? (
        <p className="px-1 py-2 text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-[#67e8f9]" />Loading…</p>
      ) : credsQ.isError ? (
        node.has_credential ? (
          // Listing a recorder's keys needs settings.manage on the recorder, which a
          // pairing-issued credential deliberately never holds. For a separately
          // deployed box this call is EXPECTED to fail — the VMS holds a working key
          // and simply cannot enumerate the recorder's own list. Showing a red error
          // would report a broken federation that is in fact working as designed.
          <p className="rounded-[10px] border border-dashed border-[rgba(160,150,245,.28)] px-3 py-3 text-xs text-[#9a92c8]">
            This VMS holds a credential for this recorder. The recorder&apos;s own credential list is
            managed on the recorder and is not readable from here — revoke keys on its console.
          </p>
        ) : (
          <p className="px-1 py-2 text-xs text-[#f87171]">{apiError(credsQ.error, "Failed to load credentials")}</p>
        )
      ) : creds.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-[rgba(160,150,245,.28)] px-3 py-3 text-center text-xs text-[#9a92c8]">
          No credentials issued yet. Pair this recorder with a code from its console — or enroll it,
          if it shares this stack&apos;s signing secret.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {creds.map((c) => {
            const revoked = !!c.revoked_at;
            return (
              <li
                key={c.id}
                className={`rounded-[10px] border px-3 py-2 ${
                  revoked ? "border-[rgba(160,150,245,.18)] bg-[rgba(150,180,245,.03)] opacity-70" : "border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon icon="heroicons-outline:key" className="shrink-0 text-sm text-[#aec2e8]" />
                    <span className="truncate text-[13px] font-medium text-[#f2f6ff]">{c.label || "credential"}</span>
                    {revoked && (
                      <span className="shrink-0 rounded-full border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] px-1.5 py-0.5 text-[9px] font-medium text-[#f87171]">Revoked</span>
                    )}
                  </span>
                  {canManage && !revoked && (
                    <button
                      onClick={() =>
                        // Revoking is irreversible and cuts this VMS off from the
                        // recorder (cameras and live streams stop resolving), so it
                        // asks first — the mutation fires only from onConfirm.
                        setConfirm({
                          title: "Revoke credential",
                          message: `Revoke “${c.label || "credential"}”? This VMS immediately loses access to ${node.name}'s cameras and streams until it is paired or enrolled again. This cannot be undone.`,
                          confirmLabel: "Revoke",
                          danger: true,
                          onConfirm: () => { revoke.mutate(c.id); setConfirm(null); },
                        })
                      }
                      disabled={revoke.isPending}
                      className="inline-flex shrink-0 items-center gap-1 rounded-[7px] border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.08)] px-2 py-1 text-[11px] text-[#f87171] transition hover:bg-[rgba(248,113,113,.16)] disabled:opacity-50"
                    >
                      <Icon icon="heroicons-outline:no-symbol" className="text-[13px]" /> Revoke
                    </button>
                  )}
                </div>
                {/* The grant list is not printed. Fifteen chips of
                    `vms.camera.read`-style permission keys is not something an
                    operator acts on here — and when a grant is actually MISSING,
                    the recorder says so and Federation shows the refusal. */}
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 pl-6 font-mono text-[10px] text-[#7e93bf]">
                  <span>issued {c.created_at ? fmtRelative(c.created_at) : "—"}</span>
                  <span>last used {c.last_used_at ? fmtRelative(c.last_used_at) : "never"}</span>
                  {revoked && <span>revoked {fmtRelative(c.revoked_at)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="!px-2.5 !py-1.5 !text-xs"
            icon="heroicons-outline:key"
            onClick={() => setPairCode("")}
          >
            {enrolled ? "Re-pair with code" : "Pair with code"}
          </Button>
          <Button
            variant="secondary"
            className="!px-2.5 !py-1.5 !text-xs"
            icon={enrolled ? "heroicons-outline:arrow-path" : "heroicons-outline:plus"}
            onClick={() => enroll.mutate()}
            disabled={enroll.isPending}
          >
            {enroll.isPending ? "Enrolling…" : enrolled ? "Re-enroll" : "Enroll"}
          </Button>
        </div>
      )}

      {/* Pair — the code an operator minted on the recorder's own console. */}
      <Modal
        open={pairCode !== null}
        onClose={() => setPairCode(null)}
        title="Pair with recorder"
        footer={
          <>
            <div className="flex-1" />
            <Button variant="secondary" onClick={() => setPairCode(null)} disabled={pair.isPending}>Cancel</Button>
            <Button
              variant="success"
              onClick={() => pair.mutate()}
              disabled={pair.isPending || !(pairCode || "").trim()}
            >
              {pair.isPending ? "Pairing…" : "Pair"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[12px] leading-relaxed text-[#7e93bf]">
            On the recorder&apos;s console open <span className="text-[#aec2e8]">Federation → Pair central VMS</span> and
            mint a code. It is one-use and expires in 15 minutes.
          </p>
          <Field
            label="Pairing code"
            value={pairCode || ""}
            onChange={(e) => setPairCode(e.target.value)}
            placeholder="8FK2N-9QTXW"
          />
        </div>
      </Modal>

      {/* The RAW credential — shown ONCE. */}
      <Modal
        open={!!issued}
        onClose={() => setIssued(null)}
        title="Federation credential"
        footer={<Button variant="secondary" onClick={() => setIssued(null)}>Done</Button>}
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-[10px] border border-[rgba(251,191,36,.3)] bg-[rgba(251,191,36,.08)] px-3 py-2 text-[12px] text-[#fbbf24]">
            <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 shrink-0 text-sm" />
            Copy this now — it is shown once and cannot be retrieved again. Store it on the recorder, then revoke + re-enroll to rotate.
          </div>
          <div>
            <p className="mb-1 font-mono text-[10px] uppercase tracking-[1.4px] text-[#9a92c8]">Credential {issued?.label ? `· ${issued.label}` : ""}</p>
            <div className="flex items-stretch gap-2">
              <code className="min-w-0 flex-1 select-all break-all rounded-[8px] border border-[rgba(160,150,245,.22)] bg-[rgba(8,15,34,.7)] px-3 py-2 font-mono text-[12px] text-[#f2f6ff]">
                {issued?.credential}
              </code>
              <Button
                variant="secondary"
                className="!px-2.5"
                icon={copied ? "heroicons-outline:check" : "heroicons-outline:clipboard"}
                onClick={copyRaw}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
          {Array.isArray(issued?.grants) && issued.grants.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {issued.grants.map((g) => (
                <span key={g} className="rounded-sm border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1.5 py-0.5 font-mono text-[9.5px] text-[#aec2e8]">{g}</span>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={revoke.isPending} />
    </>
  );
}
