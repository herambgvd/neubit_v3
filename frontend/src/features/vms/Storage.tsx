"use client";

// VMS → Storage. A READ-ONLY, node-scoped view of a recorder's storage. Single
// ownership: the standalone recorder OWNS and manages all storage; the VMS only
// READS it, through the node (/vms/federation/nodes/{id}/storage/*). Pick a recorder
// on the left, then see its disk usage, RAID health, storage pools, tier rules and
// any upstream 3rd-party NVR storage on the right. There is NO CRUD here — pools,
// tiering and formatting live on the recorder. Wears the shared console frame + the
// blue Configurations accent, exactly like its sibling federation lens (Federation).
import { useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
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
  QuietButton,
} from "@/components/console";
import { apiError } from "@/lib/api";
import { asItems, fmtBytes } from "@/lib/format";
import { vms } from "./api";
import ArchiveSection from "./components/ArchiveSection";
import StatusBadge from "./components/StatusBadge";
import type {
  FederationNode,
  NodeRaidArray,
  NodeRaidStatus,
  NodeStoragePool,
  NodeStorageUsage,
  NodeTierRule,
} from "./types";

/** One upstream 3rd-party NVR discovered from the federated camera list. */
interface UpstreamNvrRef {
  id: string;
  name: string;
}

/** The NVR linkage a federated camera may carry. The recorder's own camera dict
 *  is forwarded verbatim (backend/vision/app/vms/federation/router.py), so only
 *  the fields this view reads are named. */
interface FederatedCameraNvrLink {
  node_id?: string;
  nvr_id?: string | null;
  nvr_name?: string | null;
  nvr?: { id?: string | null; name?: string | null } | null;
}

/** A disk/usage row as this view reads it — `NodeStorageUsage` plus the
 *  alternate column names a 3rd-party NVR's HDD table uses. */
interface NodeDiskRow extends NodeStorageUsage {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  status?: string | null;
  capacity_bytes?: number | null;
}

/** A tier rule plus the older/aliased column names the recorder may still send. */
interface NodeTierRuleRow extends NodeTierRule {
  source_pool_name?: string | null;
  target_pool_name?: string | null;
  source?: string | null;
  target?: string | null;
  after_hours?: number | null;
  hours?: number | null;
}

// Storage-pool kind → label + icon (the node reports `kind`, not the legacy
// VMS-local `pool_type`).
const POOL_KIND: Record<string, { label: string; icon: string }> = {
  local: { label: "Local disk", icon: "heroicons-outline:server" },
  nfs: { label: "NFS", icon: "heroicons-outline:server-stack" },
  smb: { label: "SMB / CIFS", icon: "heroicons-outline:server-stack" },
  s3: { label: "S3 / MinIO", icon: "heroicons-outline:cloud" },
};

// RAID array health → tone/label/icon for its badge. `health` is an open string
// on the wire, so the map is keyed by string and falls back to `unknown`.
type RaidTone = "emerald" | "red" | "amber" | "muted";
const RAID_HEALTH: Record<string, { tone: RaidTone; label: string; icon: string }> = {
  healthy: { tone: "emerald", label: "Healthy", icon: "heroicons-outline:shield-check" },
  degraded: { tone: "red", label: "Degraded", icon: "heroicons:exclamation-triangle" },
  rebuilding: { tone: "amber", label: "Rebuilding", icon: "heroicons-outline:arrow-path" },
  failed: { tone: "red", label: "Failed", icon: "heroicons-outline:x-circle" },
  unknown: { tone: "muted", label: "Unknown", icon: "heroicons-outline:question-mark-circle" },
};
const RAID_TONE: Record<RaidTone, string> = {
  emerald: "border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.08)] text-nb-tealb",
  red: "border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] text-nb-crit",
  amber: "border-[rgba(251,191,36,.3)] bg-[rgba(251,191,36,.1)] text-nb-warn",
  muted: "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted",
};

// A used% → bar gradient, shared by every usage bar on the page.
function barColor(pct: number) {
  return pct > 90
    ? "bg-gradient-to-r from-nb-warn to-nb-crit"
    : pct > 70
      ? "bg-gradient-to-r from-nb-warn to-nb-warn"
      : "bg-gradient-to-r from-nb-blue to-nb-teal";
}

export default function StoragePage() {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Recorder nodes = the storage owners. Federation is the read path; fall back to
  // the media-node registry shape (both return {items} / a bare array via asItems).
  const nodesQ = useQuery({
    queryKey: ["vms-storage-nodes"],
    queryFn: () => vms.federation.nodes(),
    refetchInterval: 20_000,
  });
  const nodes = useMemo(() => asItems(nodesQ.data), [nodesQ.data]);

  // Federated cameras — grouped per node so a node's upstream 3rd-party NVRs can be
  // discovered (a camera onboarded from an NVR carries its nvr_id). Best-effort: if
  // the payload has no nvr linkage, the upstream section simply stays empty.
  const camsQ = useQuery({
    queryKey: ["vms-storage-fed-cameras"],
    queryFn: () => vms.federation.cameras(),
    refetchInterval: 30_000,
  });
  const nvrsByNode = useMemo(() => {
    const m = new Map<string, UpstreamNvrRef[]>();
    // The node's camera dict is open; read it through the linkage shape above.
    for (const c of (camsQ.data?.items || []) as FederatedCameraNvrLink[]) {
      const nid = c.node_id;
      const nvrId = c.nvr_id || c.nvr?.id;
      if (!nid || !nvrId) continue;
      const arr = m.get(nid) || [];
      if (!arr.some((n) => n.id === nvrId))
        arr.push({ id: nvrId, name: c.nvr_name || c.nvr?.name || `NVR ${nvrId}` });
      m.set(nid, arr);
    }
    return m;
  }, [camsQ.data]);

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


  const onlineCount = nodes.filter((n) => n.status === "online").length;

  return (
    <ConsolePage>
      <ConsoleGrid>
        {/* LEFT — recorder nodes (storage owners) */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:circle-stack"
            title="Recorders"
            count={nodes.length}
            actions={
              <>
                <PanelCounts
                  items={[
                    { tone: "good", value: onlineCount, label: "online" },
                    { tone: "crit", value: nodes.length - onlineCount, label: "offline" },
                  ]}
                />
                {/* The way to enrolment, in the header where every other panel
                    action lives — it was a full-width button at the foot of the
                    list, which scrolls away and reads as a create CTA. */}
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
            error={nodesQ.isError ? apiError(nodesQ.error, "Failed to load recorders") : null}
            empty={filtered.length === 0}
            emptyText={
              nodes.length === 0
                ? "No recorder nodes enrolled yet. Enroll one on the Recorders page (Devices → Recorders)."
                : "No nodes match your search"
            }
          >
            {filtered.map((n) => {
              const isSel = effectiveId === n.id;
              const online = n.status === "online";
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
                          online
                            ? "bg-nb-good shadow-[0_0_5px_#34d399]"
                            : "bg-nb-crit shadow-[0_0_5px_rgba(248,113,113,.6)]"
                        }`}
                      />
                      <p className="truncate text-[13px] font-semibold text-nb-ink">{n.name}</p>
                    </span>
                    <StatusBadge status={n.status} />
                  </div>
                  {n.label && <p className="mt-0.5 truncate pl-3.5 text-[11px] text-nb-faint">{n.label}</p>}
                  <p className="mt-0.5 truncate pl-3.5 font-mono text-[10.5px] text-nb-faint">{n.api_url || "—"}</p>
                </button>
              );
            })}
          </PanelList>

        </ConsolePanel>

        {/* CENTER — one node's storage */}
        <ConsolePanel>
          {selected ? (
            <NodeStorageDetail
              key={selected.id}
              node={selected}
              nvrs={nvrsByNode.get(selected.id) || []}
            />
          ) : (
            <EmptyPane
              icon="heroicons-outline:circle-stack"
              title="No recorder selected"
              subtitle="Choose a recorder to see the disk usage, RAID health, pools and tier rules it reports."
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>
    </ConsolePage>
  );
}

// ── Right pane: one node's storage, read-only ───────────────────────────────
function NodeStorageDetail({ node, nvrs }: { node: FederationNode; nvrs: UpstreamNvrRef[] }) {
  const reachableOffline = node.status !== "online";

  const usageQ = useQuery({
    queryKey: ["vms-node-storage-usage", node.id],
    queryFn: () => vms.federation.storage.usage(node.id),
    refetchInterval: 30_000,
    retry: false,
  });
  const poolsQ = useQuery({
    queryKey: ["vms-node-storage-pools", node.id],
    queryFn: () => vms.federation.storage.pools(node.id),
    retry: false,
  });
  const rulesQ = useQuery({
    queryKey: ["vms-node-storage-tier-rules", node.id],
    queryFn: () => vms.federation.storage.tierRules(node.id),
    retry: false,
  });
  const raidQ = useQuery({
    queryKey: ["vms-node-storage-raid", node.id],
    queryFn: () => vms.federation.storage.raid(node.id),
    refetchInterval: 30_000,
    retry: false,
  });

  const usage: NodeStorageUsage = usageQ.data || {};
  const pools = useMemo(() => asItems(poolsQ.data), [poolsQ.data]);
  // The recorder still sends a few aliased tier-rule columns; read them as such.
  const rules = useMemo(() => asItems(rulesQ.data) as NodeTierRuleRow[], [rulesQ.data]);
  const poolNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of pools) m[p.id] = p.name;
    return m;
  }, [pools]);

  const total = usage.total_bytes ?? 0;
  const free = usage.free_bytes ?? 0;
  const used = usage.used_bytes ?? (total && free ? total - free : 0);
  const usedPct = usage.used_percent != null ? usage.used_percent : total > 0 ? (used / total) * 100 : 0;
  const reachable = usage.reachable !== false && !reachableOffline;

  return (
    <>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nb-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-nb-blue/40 bg-[rgba(96,165,250,.12)] text-nb-blueb">
            <Icon icon="heroicons-outline:circle-stack" className="text-base" />
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
        {/* NO read-only banner. Nothing on this screen is editable, so the
            sentence explained an absence — and it said it twice, once here and
            once under the list. What an operator cannot do is visible from the
            fact that there is nothing to press. */}
        {reachableOffline && (
          <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-nb-crit/40 bg-nb-crit/10 px-3 py-2 text-[12px] text-nb-crit">
            <Icon icon="heroicons:exclamation-triangle" className="shrink-0 text-sm" />
            This recorder is not reachable right now — its storage figures may be stale until it comes back online.
          </div>
        )}

        {/* Disk usage */}
        <SectionLabel>Disk usage</SectionLabel>
        {usageQ.isLoading ? (
          <InlineLoading />
        ) : usageQ.isError ? (
          <InlineError error={usageQ.error} fallback="Failed to load disk usage" />
        ) : (
          <div className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] p-3">
            {total > 0 ? (
              <>
                <div className="mb-2 h-2 overflow-hidden rounded-full border border-nb-line bg-black/40">
                  <div className={`h-full rounded-full ${barColor(usedPct)}`} style={{ width: `${Math.min(100, usedPct)}%` }} />
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-nb-soft">
                  <span>{fmtBytes(used)} used ({Math.round(usedPct)}%)</span>
                  <span>{fmtBytes(free)} free</span>
                  <span>{fmtBytes(total)} total</span>
                </div>
              </>
            ) : (
              <p className="text-sm text-nb-soft">
                {reachable ? "No disk usage reported by this recorder." : "Usage unavailable while the recorder is unreachable."}
              </p>
            )}
            {usedPct > 90 && total > 0 && (
              <div className="mt-2 flex items-center gap-1 text-xs text-nb-crit">
                <Icon icon="heroicons:exclamation-triangle" className="text-xs" /> Storage nearly full
              </div>
            )}
          </div>
        )}

        {/* RAID */}
        <SectionLabel className="mt-4">RAID health</SectionLabel>
        <RaidSection query={raidQ} />

        {/* Pools */}
        <SectionLabel className="mt-4" count={pools.length}>Storage pools</SectionLabel>
        {poolsQ.isLoading ? (
          <InlineLoading />
        ) : poolsQ.isError ? (
          <InlineError error={poolsQ.error} fallback="Failed to load pools" />
        ) : pools.length === 0 ? (
          <EmptyNote>This recorder reports no storage pools.</EmptyNote>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {pools.map((p) => (
              <PoolCard key={p.id} pool={p} />
            ))}
          </div>
        )}

        {/* Tier rules */}
        <SectionLabel className="mt-4" count={rules.length}>Tier rules</SectionLabel>
        {rulesQ.isLoading ? (
          <InlineLoading />
        ) : rulesQ.isError ? (
          <InlineError error={rulesQ.error} fallback="Failed to load tier rules" />
        ) : rules.length === 0 ? (
          <EmptyNote>No tiering rules — recordings stay on their pool until retention removes them.</EmptyNote>
        ) : (
          <ul className="space-y-1.5">
            {rules.map((r) => (
              <TierRuleRow key={r.id} rule={r} poolNames={poolNames} />
            ))}
          </ul>
        )}

        {/* Archive + restore — the cold tier. Last of the storage sections because
            it answers a question the others raise: the timeline is empty here, is
            that footage gone? */}
        <SectionLabel className="mt-4">Archive &amp; restore</SectionLabel>
        <ArchiveSection node={node} />

        {/* Upstream 3rd-party NVR storage */}
        {nvrs.length > 0 && (
          <>
            <SectionLabel className="mt-4" count={nvrs.length}>Upstream NVR storage</SectionLabel>
            <div className="space-y-2">
              {nvrs.map((nvr) => (
                <UpstreamNvrCard key={nvr.id} nodeId={node.id} nvr={nvr} />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ── RAID ────────────────────────────────────────────────────────────────────
function RaidSection({ query }: { query: UseQueryResult<NodeRaidStatus> }) {
  if (query.isLoading) return <InlineLoading />;
  if (query.isError) return <InlineError error={query.error} fallback="Failed to load RAID status" />;

  const data: NodeRaidStatus = query.data || {};
  const list: NodeRaidArray[] = data.arrays || (Array.isArray(data) ? data : []);

  if (data.available === false) {
    return (
      <EmptyNote>
        {data.reason || "This recorder has no software-RAID (mdadm) array — disks are used directly."}
      </EmptyNote>
    );
  }
  if (list.length === 0) {
    return <EmptyNote>No RAID arrays reported by this recorder.</EmptyNote>;
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {list.map((arr) => (
        <RaidArrayCard key={arr.device} arr={arr} />
      ))}
    </div>
  );
}

function RaidArrayCard({ arr }: { arr: NodeRaidArray }) {
  const h = RAID_HEALTH[arr.health ?? "unknown"] || RAID_HEALTH.unknown;
  const alarm = arr.health === "degraded" || arr.health === "failed";
  const pct = arr.rebuild_percent;
  return (
    <div className={`rounded-[10px] border bg-[rgba(10,18,40,.5)] p-3 ${alarm ? "border-[rgba(248,113,113,.3)]" : "border-nb-line"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-mono text-[13px] font-medium text-nb-ink">
          <Icon icon="heroicons-outline:server-stack" className="text-sm text-nb-faint" />
          {arr.device}
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${RAID_TONE[h.tone]}`}>
          <Icon icon={h.icon} className="text-[11px]" /> {h.label}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 text-center">
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-1.5">
          <div className="text-[13px] font-semibold tabular-nums text-nb-ink">{(arr.level || "—").toString().toUpperCase()}</div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wide text-nb-faint">Level</div>
        </div>
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-1.5">
          <div className="text-[13px] font-semibold tabular-nums text-nb-good">
            {arr.working_devices ?? "—"}/{arr.total_devices ?? "—"}
          </div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wide text-nb-faint">Working</div>
        </div>
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-1.5">
          <div className={`text-[13px] font-semibold tabular-nums ${arr.failed_devices ? "text-nb-crit" : "text-nb-ink"}`}>
            {arr.failed_devices ?? 0}
          </div>
          <div className="mt-0.5 text-[9px] uppercase tracking-wide text-nb-faint">Failed</div>
        </div>
      </div>
      {arr.health === "rebuilding" && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-[11px] text-nb-muted">
            <span>Rebuilding</span>
            {pct != null && <span className="tabular-nums">{pct}%</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full border border-nb-line bg-black/40">
            <div className="h-full rounded-full bg-nb-warn transition-all" style={{ width: `${pct ?? 30}%` }} />
          </div>
        </div>
      )}
      {alarm && (
        <p className="mt-2 text-[11px] text-nb-crit">
          Replace the failed disk on the recorder and the array rebuilds automatically. Until then redundancy is lost.
        </p>
      )}
    </div>
  );
}

// ── Pool card (read-only) ───────────────────────────────────────────────────
function PoolCard({ pool }: { pool: NodeStoragePool }) {
  const kind = POOL_KIND[pool.kind ?? ""] || { label: pool.kind || "Pool", icon: "heroicons-outline:server" };
  const u = (pool.usage || {}) as NodeDiskRow;
  const cap = u.total_bytes ?? u.capacity_bytes ?? pool.max_size_bytes ?? 0;
  const used = u.used_bytes ?? 0;
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] p-3">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
          <Icon icon={kind.icon} className="text-sm" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold text-nb-ink">{pool.name}</p>
            {pool.is_default && (
              <span className="rounded-full bg-[rgba(96,165,250,.1)] px-1.5 py-0.5 text-[9px] font-medium text-nb-blueb">Default</span>
            )}
          </div>
          <p className="text-[11px] text-nb-soft">{kind.label}</p>
        </div>
      </div>
      {pool.path && <p className="mt-1.5 truncate font-mono text-[10px] text-nb-faint" title={pool.path}>{pool.path}</p>}
      {cap > 0 && (
        <div className="mt-2">
          <div className="mb-1 h-1.5 overflow-hidden rounded-full border border-nb-line bg-black/40">
            <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex justify-between text-[10px] text-nb-faint">
            <span>{fmtBytes(used)} used</span>
            <span>{fmtBytes(cap)} total</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tier rule row (read-only) ───────────────────────────────────────────────
const fmtAge = (h: number | null | undefined) =>
  h == null ? "—" : h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;

function TierRuleRow({ rule, poolNames }: { rule: NodeTierRuleRow; poolNames: Record<string, string> }) {
  const src = poolNames[rule.source_pool_id ?? ""] || rule.source_pool_name || rule.source || "—";
  const dst = poolNames[rule.target_pool_id ?? ""] || rule.target_pool_name || rule.target || "—";
  const hours = rule.after_age_hours ?? rule.after_hours ?? rule.hours;
  return (
    <li className="flex items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2">
      <Icon icon="heroicons-outline:arrows-right-left" className="shrink-0 text-sm text-nb-blueb" />
      {rule.name && <span className="shrink-0 text-[13px] font-medium text-nb-ink">{rule.name}</span>}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-nb-soft">
        <span className="truncate">{src}</span>
        <Icon icon="heroicons-outline:arrow-long-right" className="shrink-0 text-sm text-nb-faint" />
        <span className="truncate">{dst}</span>
      </span>
      <span className="shrink-0 font-mono text-[10.5px] text-nb-faint">after {fmtAge(hours)}</span>
    </li>
  );
}

// ── Upstream 3rd-party NVR storage ──────────────────────────────────────────
function UpstreamNvrCard({ nodeId, nvr }: { nodeId: string; nvr: UpstreamNvrRef }) {
  const q = useQuery({
    queryKey: ["vms-node-upstream-nvr-storage", nodeId, nvr.id],
    queryFn: () => vms.federation.storage.upstreamNvr(nodeId, nvr.id),
    retry: false,
  });

  const data = q.data || {};
  // A 3rd-party NVR's HDD table uses its own column names; read it as a disk row.
  const disks = asItems(data.disks ? { items: data.disks } : data) as NodeDiskRow[];
  const available = data.available !== false;

  return (
    <div className="rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon="heroicons-outline:circle-stack" className="shrink-0 text-sm text-nb-faint" />
          <p className="truncate text-[13px] font-medium text-nb-ink">{nvr.name}</p>
        </div>
        <span className="shrink-0 rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] px-2 py-0.5 text-[9.5px] uppercase tracking-wide text-nb-faint">
          reported by recorder
        </span>
      </div>
      {q.isLoading ? (
        <InlineLoading />
      ) : q.isError ? (
        <InlineError error={q.error} fallback="Failed to load NVR storage" />
      ) : !available ? (
        <p className="mt-2 text-[12px] text-nb-soft">Storage figures are not yet available from this NVR.</p>
      ) : disks.length === 0 ? (
        <p className="mt-2 text-[12px] text-nb-soft">This NVR reported no disks.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {disks.map((d, i) => {
            const cap = d.total_bytes ?? d.capacity_bytes ?? 0;
            const used = d.used_bytes ?? 0;
            const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
            return (
              <li key={d.id || d.name || i} className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] px-2.5 py-1.5">
                <div className="flex items-center justify-between gap-2 text-[11.5px]">
                  <span className="truncate font-mono text-nb-soft">{d.name || d.model || `Disk ${i + 1}`}</span>
                  <span className="shrink-0 text-nb-faint">
                    {d.status || (cap > 0 ? `${fmtBytes(used)} / ${fmtBytes(cap)}` : "—")}
                  </span>
                </div>
                {cap > 0 && (
                  <div className="mt-1 h-1 overflow-hidden rounded-full border border-nb-line bg-black/40">
                    <div className={`h-full rounded-full ${barColor(pct)}`} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Small shared bits ───────────────────────────────────────────────────────
function SectionLabel({
  children,
  count,
  className = "",
}: {
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <div className={`mb-2 flex items-center gap-2 ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{children}</span>
      {count != null && (
        <span className="rounded-full border border-nb-line bg-white/5 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-nb-soft">
          {count}
        </span>
      )}
    </div>
  );
}

function InlineLoading() {
  return (
    <p className="flex items-center gap-1.5 px-1 py-3 text-xs text-nb-faint">
      <Icon icon="svg-spinners:180-ring" className="text-sm text-nb-blueb" /> Loading…
    </p>
  );
}

function InlineError({ error, fallback }: { error: unknown; fallback: string }) {
  return <p className="px-1 py-3 text-xs text-nb-crit">{apiError(error, fallback)}</p>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-4 text-center text-xs text-nb-faint">
      {children}
    </p>
  );
}
