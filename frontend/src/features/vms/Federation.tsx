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
import { useMemo, useState } from "react";
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
  EmptyPane,
} from "@/components/console";
import { apiError } from "@/lib/api";
import type { FederatedCamera } from "@/lib/types";
import { vms } from "./api";
import StatusBadge from "./components/StatusBadge";
import FederationNodeDetail from "./components/FederationNodeDetail";

export default function FederationPage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // Read the envelope directly: the query is typed, so `.items` is already
  // FederationNode[]. `asItems(data)` widened the not-yet-loaded case to never[].
  const nodes = useMemo(() => nodesQ.data?.items ?? [], [nodesQ.data]);
  const cameras = useMemo(() => camsQ.data?.items || [], [camsQ.data]);
  const unreachable = useMemo(() => camsQ.data?.unreachable || [], [camsQ.data]);
  const unreachableIds = useMemo(
    () => new Set<string>(unreachable.map((u) => u.node_id)),
    [unreachable],
  );

  // Cameras grouped by their owning node.
  const camsByNode = useMemo(() => {
    const m = new Map<string, FederatedCamera[]>();
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

  // The explicit choice, or the first row when there is none. Derived here
  // rather than synced by an effect, which rendered one frame with nothing
  // selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;

  const selected = useMemo(
    () => nodes.find((n) => n.id === effectiveId) || null,
    [nodes, effectiveId],
  );


  const reachableCount = nodes.filter(
    (n) => n.status === "online" && !unreachableIds.has(n.id),
  ).length;
  const totalCams = cameras.length;
  const onlineCams = cameras.filter((c) => c.status === "online").length;
  // A node in this state is REACHABLE and reports online: nothing else on this
  // screen would say that half its federated surface is being refused.
  const refused = nodes.filter((n) => n.credential_error).length;
  const channelsUsed = nodes.reduce((a, n) => a + (n.used_channels || 0), 0);
  const channelsCap = nodes.reduce((a, n) => a + (n.capacity_channels || 0), 0);

  return (
    <ConsolePage>
      <EstateStrip
        nodes={nodes.length}
        reachable={reachableCount}
        camerasOnline={onlineCams}
        cameras={totalCams}
        channelsUsed={channelsUsed}
        channelsCap={channelsCap}
        refused={refused}
        loading={nodesQ.isLoading}
      />

      <ConsoleGrid>
        {/* LEFT — enrolled nodes */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:share"
            title="Federated nodes"
            count={nodes.length}
            actions={
              <>
              <PanelCounts
                items={[
                  { tone: "good", value: reachableCount, label: "reachable" },
                  { tone: "crit", value: nodes.length - reachableCount, label: "unreachable" },
                ]}
              />
              {/* The way to enrolment, in the header where every other panel
                  action lives. It was a full-width button and a paragraph at the
                  foot of the list saying the same thing twice. */}
              <Link
                href="/devices/recorders"
                title="Manage recorders"
                aria-label="Manage recorders"
                className="grid h-7 w-7 place-items-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-outline:cog-6-tooth" className="text-sm" />
              </Link>
              </>
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
              const isSel = effectiveId === n.id;
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
                  {isSel && <span className="absolute inset-y-0 left-0 w-0.5 rounded-l-sm bg-nb-blue" />}
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
                  {n.credential_error && (
                    <p className="mt-0.5 flex items-center gap-1 pl-3.5 text-[10.5px] text-nb-warn">
                      <Icon icon="heroicons:key" className="shrink-0 text-[11px]" />
                      credential refused
                    </p>
                  )}
                  {n.label && <p className="mt-0.5 truncate pl-3.5 text-[11px] text-nb-faint">{n.label}</p>}
                  <p className="mt-0.5 pl-3.5 font-mono text-[10.5px] tabular-nums text-nb-faint">
                    {isUnreachable ? "unreachable — cameras hidden" : `${nodeOnline}/${nodeCams.length} camera(s) online`}
                  </p>
                </button>
              );
            })}
          </PanelList>

        </ConsolePanel>

        {/* CENTER — node detail */}
        <ConsolePanel>
          {selected ? (
            <FederationNodeDetail
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

interface EstateStripProps {
  nodes: number;
  reachable: number;
  cameras: number;
  camerasOnline: number;
  channelsUsed: number;
  channelsCap: number;
  refused: number;
  loading?: boolean;
}

/**
 * The estate in one line: is the federation healthy, and how much of it is in use.
 *
 * These four numbers were only obtainable by selecting each node in turn and adding
 * up — which is not a thing anyone does, so nobody knew. `refused` is the one that
 * has to be here rather than inside a node: a recorder whose credential is being
 * refused is REACHABLE and reports online, so the reachable count says everything is
 * fine while part of the federated surface is closed.
 */
function EstateStrip({
  nodes,
  reachable,
  cameras,
  camerasOnline,
  channelsUsed,
  channelsCap,
  refused,
  loading,
}: EstateStripProps) {
  const cells: { label: string; value: string; tone?: string; title?: string }[] = [
    {
      label: "Recorders",
      value: loading ? "…" : `${reachable}/${nodes}`,
      tone: nodes > 0 && reachable < nodes ? "text-nb-crit" : "text-nb-ink",
      title: "Enrolled recorders that are online and answering",
    },
    {
      label: "Federated cameras",
      value: loading ? "…" : `${camerasOnline}/${cameras}`,
      tone: cameras > 0 && camerasOnline < cameras ? "text-nb-warn" : "text-nb-ink",
      title: "Cameras owned by those recorders that are streaming",
    },
    {
      label: "Channels used",
      value: loading ? "…" : channelsCap ? `${channelsUsed}/${channelsCap}` : `${channelsUsed}`,
      title: "Recording channels in use across the estate, against the declared capacity",
    },
    {
      label: "Credentials refused",
      value: loading ? "…" : String(refused),
      tone: refused > 0 ? "text-nb-warn" : "text-nb-ink",
      title:
        "Recorders that are online but refusing our federation credential — a credential freezes the grants it was minted with",
    },
  ];

  return (
    <div className="mb-3 grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-4">
      {cells.map((c) => (
        <div
          key={c.label}
          className="rounded-[10px] border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2"
          title={c.title}
        >
          <p className="text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-muted">
            {c.label}
          </p>
          <p className={`mt-0.5 font-mono text-[15px] font-semibold tabular-nums ${c.tone || "text-nb-ink"}`}>
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}
