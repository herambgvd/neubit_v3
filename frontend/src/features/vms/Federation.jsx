"use client";

// VMS → Federation. The FEDERATION view of the recorder estate: enrolled recorder
// NODES + the cameras each node OWNS, pulled up read-only and streamed THROUGH the
// node (see /vms/federation). This is deliberately NOT the Recorders registry
// (/devices/recorders) — that page manages a node's identity, endpoints, capacity
// and lifecycle (add / edit / drain / delete). Here we show the FEDERATION-specific
// picture: which enrolled nodes are reachable right now, and the aggregate of every
// federated camera they expose (online / offline), with a jump to the Live wall.
// Read-only by design; management still lives on the Recorders page.
//
// Reached from Configurations → System & Policy, so it wears the shared console
// frame (components/console) and the blue Configurations accent — same shell as
// Users & Roles / Sites, not the teal Surveillance look it used to carry.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import Link from "next/link";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelCounts,
  PanelSearch,
  PanelList,
  PanelFooter,
  EmptyPane,
  InfoCell,
  QuietButton,
} from "@/components/console";
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
    <ConsolePage>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]">
        {/* LEFT — enrolled nodes */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:share"
            title="Federated nodes"
            count={nodes.length}
            actions={
              <PanelCounts
                items={[
                  { tone: "good", value: reachableCount, label: "reachable" },
                  { tone: "crit", value: nodes.length - reachableCount, label: "unreachable" },
                ]}
              />
            }
          />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search name, label or URL…" />

          <PanelList
            loading={nodesQ.isLoading}
            error={nodesQ.isError ? apiError(nodesQ.error, "Failed to load federated nodes") : null}
            empty={filtered.length === 0}
            emptyText={
              nodes.length === 0
                ? "No recorder nodes enrolled yet. Enroll one on the Recorders page (Devices → Recorders)."
                : "No nodes match your search"
            }
          >
            {filtered.map((n) => {
              const isSel = selectedId === n.id;
              const nodeCams = camsByNode.get(n.id) || [];
              const nodeOnline = nodeCams.filter((c) => c.status === "online").length;
              const isUnreachable = unreachableIds.has(n.id) || n.status !== "online";
              return (
                <button
                  key={n.id}
                  onClick={() => setSelectedId(n.id)}
                  className={`relative block w-full overflow-hidden rounded-[10px] border px-3 py-2.5 text-left transition ${
                    isSel
                      ? "border-nb-blue bg-[rgba(96,165,250,.1)]"
                      : "border-nb-line bg-[rgba(10,18,40,.5)] hover:border-nb-blue/60 hover:bg-[rgba(96,165,250,.06)]"
                  }`}
                >
                  {isSel && <span className="absolute inset-y-0 left-0 w-0.5 rounded-l bg-nb-blue" />}
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          !isUnreachable
                            ? "bg-nb-good shadow-[0_0_5px_#34d399]"
                            : "bg-nb-crit shadow-[0_0_5px_rgba(248,113,113,.6)]"
                        }`}
                      />
                      <p className="truncate text-[13px] font-semibold text-nb-ink">{n.name}</p>
                    </span>
                    <StatusBadge status={n.status} />
                  </div>
                  {n.label && <p className="mt-0.5 truncate pl-3.5 text-[11px] text-nb-faint">{n.label}</p>}
                  <p className="mt-0.5 pl-3.5 font-mono text-[10.5px] tabular-nums text-nb-faint">
                    {isUnreachable ? "unreachable — cameras hidden" : `${nodeOnline}/${nodeCams.length} camera(s) online`}
                  </p>
                </button>
              );
            })}
          </PanelList>

          {/* Read-only console: no create CTA — enrollment lives on Recorders. */}
          <PanelFooter>
            <QuietButton as={Link} href="/devices/recorders" icon="heroicons-outline:cog-6-tooth" className="w-full justify-center">
              Manage recorders
            </QuietButton>
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              Nodes are enrolled on the <b className="text-nb-blueb">Recorders</b> page. Federation
              shows only which of them are reachable and what they expose — {onlineCams}/{totalCams} cameras online.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* CENTER — node detail */}
        <ConsolePanel>
          {selected ? (
            <NodeDetail
              key={selected.id}
              node={selected}
              cameras={camsByNode.get(selected.id) || []}
              camsLoading={camsQ.isLoading}
              unreachable={unreachableIds.has(selected.id) || selected.status !== "online"}
            />
          ) : (
            <EmptyPane
              icon="heroicons-outline:share"
              title="No node selected"
              subtitle="Choose an enrolled recorder to see its reachability and the cameras it federates."
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}

// Right pane: one enrolled node's reachability + the cameras it federates. Read-only
// — lifecycle/endpoint edits live on the Recorders page; this is the federation lens.
function NodeDetail({ node, cameras, camsLoading, unreachable }) {
  const cap = node.capacity_channels;
  const used = node.used_channels ?? cameras.length;
  const online = cameras.filter((c) => c.status === "online").length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nb-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-nb-blue/40 bg-[rgba(96,165,250,.12)] text-nb-blueb">
            <Icon icon="heroicons-outline:share" className="text-base" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-nb-ink">{node.name}</h1>
            <p className="truncate font-mono text-[11px] text-nb-faint">{node.api_url || "—"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={node.status} />
          <QuietButton as={Link} href="/devices/recorders" icon="heroicons-outline:cog-6-tooth" className="!py-1.5 !text-xs">
            Manage
          </QuietButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {unreachable && (
          <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-nb-crit/40 bg-nb-crit/10 px-3 py-2 text-[12px] text-nb-crit">
            <Icon icon="heroicons-outline:exclamation-triangle" className="shrink-0 text-sm" />
            This node is not reachable right now — its federated cameras can&apos;t be listed or streamed until it comes back online.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={node.status || "unknown"} />
          <InfoCell label="Channels" value={<span>{used}<span className="text-nb-faint"> / {cap != null ? cap : "∞"}</span></span>} />
          <InfoCell label="Location / label" value={node.label || "—"} />
          <InfoCell label="Last heartbeat" value={node.last_heartbeat ? fmtRelative(node.last_heartbeat) : "—"} />
        </div>

        <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Endpoint</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCell label="API URL" value={node.api_url || "—"} mono />
        </div>

        <div className="mb-2 mt-4 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">Federated cameras</p>
          <span className="rounded-full border border-nb-line bg-white/5 px-2 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
            {online}/{cameras.length} online
          </span>
        </div>
        {camsLoading ? (
          <p className="flex items-center gap-1.5 px-1 py-3 text-xs text-nb-faint">
            <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" />Loading…
          </p>
        ) : cameras.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs text-nb-faint">
            {unreachable ? "Cameras are unavailable while this node is unreachable." : "This node exposes no federated cameras."}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {cameras.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-1.5">
                <StatusDot status={c.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-nb-ink" title={c.name}>{c.name}</span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[.5px] text-nb-faint">{c.status}</span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-nb-faint">
          <Icon icon="heroicons-outline:play-circle" className="text-sm text-nb-blueb" />
          Federated cameras stream through their node — view them live on the
          <Link href="/streaming" className="text-nb-blueb underline decoration-dotted underline-offset-2 hover:text-nb-ink">Live wall</Link>.
        </p>
      </div>
    </>
  );
}
