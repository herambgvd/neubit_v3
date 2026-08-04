"use client";

// VMS → Federation. The FEDERATION view of the recorder estate: enrolled recorder
// NODES + the cameras each node OWNS, pulled up read-only and streamed THROUGH the
// node (see /vms/federation). This is deliberately NOT the Recorders registry
// (/devices/recorders) — that page manages a node's identity, endpoints, capacity
// and lifecycle (add / edit / drain / delete). Here we show the FEDERATION-specific
// picture: which enrolled nodes are reachable right now, and the aggregate of every
// federated camera they expose (online / offline), with a jump to the Live wall.
// Read-only by design; management still lives on the Recorders page.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative } from "@/lib/format";
import { vms } from "./api";
import StatusBadge, { StatusDot } from "./components/StatusBadge";

export default function FederationPage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  // Enrolled recorder nodes (the federation membership) + every federated camera,
  // node-tagged. The cameras call also reports nodes it couldn't reach → surfaced
  // honestly rather than silently dropped.
  const nodesQ = useQuery({
    queryKey: ["vms-federation-nodes"],
    queryFn: () => vms.federation.nodes(),
    refetchInterval: 20_000,
  });
  const camsQ = useQuery({
    queryKey: ["vms-federation-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 20_000,
  });

  const nodes = useMemo(() => asItems(nodesQ.data), [nodesQ.data]);
  const cameras = useMemo(() => camsQ.data?.items || [], [camsQ.data]);
  const unreachable = useMemo(() => camsQ.data?.unreachable || [], [camsQ.data]);
  const unreachableIds = useMemo(
    () => new Set(unreachable.map((u) => u.node_id)),
    [unreachable],
  );

  // Cameras grouped by their owning node.
  const camsByNode = useMemo(() => {
    const m = new Map();
    for (const c of cameras) {
      const arr = m.get(c.node_id) || [];
      arr.push(c);
      m.set(c.node_id, arr);
    }
    return m;
  }, [cameras]);

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

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) || null,
    [nodes, selectedId],
  );

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const reachableCount = nodes.filter(
    (n) => n.status === "online" && !unreachableIds.has(n.id),
  ).length;
  const totalCams = cameras.length;
  const onlineCams = cameras.filter((c) => c.status === "online").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title="Federated nodes"
            icon="heroicons:share"
            count={nodes.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name, label or URL…"
          >
            <div className="flex flex-wrap items-center gap-3 px-4 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[1.2px]">
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#34d399] shadow-[0_0_5px_#34d399]" /><span className="text-[#aec2e8]">{reachableCount} reachable</span></span>
              <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]" /><span className="text-[#7e93bf]">{nodes.length - reachableCount} unreachable</span></span>
              <span className="text-[#7e93bf]">· {onlineCams}/{totalCams} cams online</span>
            </div>

            {nodesQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base text-[#67e8f9]" />Loading…</div>
            ) : nodesQ.isError ? (
              <div className="px-4 py-6 text-center text-xs text-[#f87171]">{apiError(nodesQ.error, "Failed to load federated nodes")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#9a92c8]">{nodes.length === 0 ? "No recorder nodes enrolled yet. Enroll one on the Recorders page (Devices → Recorders)." : "No matches."}</div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((n) => {
                  const isSel = selectedId === n.id;
                  const nodeCams = camsByNode.get(n.id) || [];
                  const nodeOnline = nodeCams.filter((c) => c.status === "online").length;
                  const isUnreachable = unreachableIds.has(n.id) || n.status !== "online";
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={`relative block w-full overflow-hidden rounded-[13px] border px-3 py-2.5 text-left backdrop-blur-sm transition ${isSel ? "border-[#22d3ee] bg-[rgba(34,211,238,.08)] shadow-[0_0_0_1px_rgba(34,211,238,.4)]" : "border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] hover:border-[rgba(34,211,238,.5)] hover:bg-[rgba(34,211,238,.06)]"}`}
                    >
                      {isSel && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l bg-[#22d3ee]" />}
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className={`h-2 w-2 shrink-0 rounded-full ${!isUnreachable ? "bg-[#34d399] shadow-[0_0_5px_#34d399]" : "bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]"}`} />
                          <p className="truncate font-mono text-xs font-semibold text-[#f2f6ff]">{n.name}</p>
                        </span>
                        <StatusBadge status={n.status} />
                      </div>
                      {n.label && <p className="mt-0.5 truncate pl-3.5 text-[10px] text-[#9a92c8]">{n.label}</p>}
                      <p className="mt-0.5 pl-3.5 font-mono text-[10px] tabular-nums text-[#7e93bf]">
                        {isUnreachable ? "unreachable — cameras hidden" : `${nodeOnline}/${nodeCams.length} camera(s) online`}
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
          <NodeDetail
            key={selected.id}
            node={selected}
            cameras={camsByNode.get(selected.id) || []}
            camsLoading={camsQ.isLoading}
            unreachable={unreachableIds.has(selected.id) || selected.status !== "online"}
          />
        ) : (
          <EmptyDetail icon="heroicons:share" title="No node selected" subtitle="Choose an enrolled recorder to see its reachability and the cameras it federates." />
        )}
      </MasterDetail>
    </div>
  );
}

function InfoCell({ label, value, mono = false }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[1.4px] text-[#9a92c8]">{label}</p>
      <p className={`mt-0.5 truncate text-[13px] font-medium text-[#f2f6ff] ${mono ? "font-mono" : ""}`} title={typeof value === "string" ? value : undefined}>{value ?? "—"}</p>
    </div>
  );
}

// Right pane: one enrolled node's reachability + the cameras it federates. Read-only
// — lifecycle/endpoint edits live on the Recorders page; this is the federation lens.
function NodeDetail({ node, cameras, camsLoading, unreachable }) {
  const cap = node.capacity_channels;
  const used = node.used_channels ?? cameras.length;
  const online = cameras.filter((c) => c.status === "online").length;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(160,150,245,.22)] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.12)] text-[#67e8f9]">
            <Icon icon="heroicons:share" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate font-mono text-base font-semibold text-[#f2f6ff]">{node.name}</h1>
            <p className="truncate font-mono text-[11px] text-[#9a92c8]">{node.api_url || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <Link
            href="/devices/recorders"
            className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(150,180,245,.22)] px-2.5 py-1.5 text-xs font-medium text-[#aec2e8] transition hover:border-[#22d3ee] hover:text-[#67e8f9]"
          >
            <Icon icon="heroicons-outline:cog-6-tooth" className="text-sm" /> Manage
          </Link>
        </div>
      </div>

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        {unreachable && (
          <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.08)] px-3 py-2 text-[12px] text-[#fca5a5]">
            <Icon icon="heroicons-outline:exclamation-triangle" className="shrink-0 text-sm" />
            This node is not reachable right now — its federated cameras can't be listed or streamed until it comes back online.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={node.status || "unknown"} />
          <InfoCell label="Channels" value={<span>{used}<span className="text-[#7e93bf]"> / {cap != null ? cap : "∞"}</span></span>} />
          <InfoCell label="Location / label" value={node.label || "—"} />
          <InfoCell label="Last heartbeat" value={node.last_heartbeat ? fmtRelative(node.last_heartbeat) : "—"} />
        </div>

        <p className="mb-2 mt-4 font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Endpoint</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell label="API URL" value={node.api_url || "—"} mono />
        </div>

        <div className="mb-2 mt-4 flex items-center justify-between">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[1.6px] text-[#9a92c8]">Federated cameras</p>
          <span className="rounded-full border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.06)] px-1.5 font-mono text-[10px] font-semibold tabular-nums text-[#aec2e8]">{online}/{cameras.length} online</span>
        </div>
        {camsLoading ? (
          <p className="px-1 py-3 text-xs text-[#9a92c8]"><Icon icon="svg-spinners:180-ring" className="mr-1 inline text-sm text-[#67e8f9]" />Loading…</p>
        ) : cameras.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-[rgba(160,150,245,.28)] px-3 py-4 text-center text-xs text-[#9a92c8]">
            {unreachable ? "Cameras are unavailable while this node is unreachable." : "This node exposes no federated cameras."}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {cameras.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-[10px] border border-[rgba(160,150,245,.22)] bg-[rgba(150,180,245,.04)] px-3 py-1.5">
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#f2f6ff]" title={c.name}>{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.5px] text-[#7e93bf]">{c.status}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#7e93bf]">
          <Icon icon="heroicons-outline:play-circle" className="text-sm text-[#67e8f9]" />
          Federated cameras stream through their node — view them live on the
          <Link href="/streaming" className="text-[#67e8f9] underline decoration-dotted underline-offset-2 hover:text-[#22d3ee]">Live wall</Link>.
        </p>
      </div>
    </section>
  );
}
