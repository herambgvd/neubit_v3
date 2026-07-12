"use client";

// VMS → Storage. Configure where recordings live and how they age:
//   • Pools — local / NFS / SMB / S3 targets with usage bars, default + active
//     toggles (CRUD).
//   • Tier rules — move recordings source → target after N hours (hot → cold).
//   • Retention overview — a read-out of per-pool caps + rule coverage.
// Ported from gvd_nvr's Storage page, reskinned to v3's dark tokens + the
// shared kit/common layer. Lives under Config → Storage.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, EmptyState, MetricRow, PageHeader } from "@/components/ui/kit";
import { TabBar } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, fmtBytes } from "@/lib/format";
import { vms } from "./api";
import StoragePoolCard from "./components/StoragePoolCard";
import StoragePoolModal from "./components/StoragePoolModal";
import TierRuleModal from "./components/TierRuleModal";

const TABS = [
  { key: "pools", label: "Pools", icon: "heroicons-outline:circle-stack" },
  { key: "rules", label: "Tier Rules", icon: "heroicons-outline:arrows-right-left" },
  { key: "raid", label: "RAID", icon: "heroicons-outline:server-stack" },
];

// Health → tone/label/icon for a RAID array badge.
const RAID_HEALTH = {
  healthy: { tone: "emerald", label: "Healthy", icon: "heroicons-outline:shield-check" },
  degraded: { tone: "red", label: "Degraded", icon: "heroicons-outline:exclamation-triangle" },
  rebuilding: { tone: "amber", label: "Rebuilding", icon: "heroicons-outline:arrow-path" },
  failed: { tone: "red", label: "Failed", icon: "heroicons-outline:x-circle" },
  unknown: { tone: "muted", label: "Unknown", icon: "heroicons-outline:question-mark-circle" },
};
const RAID_TONE = {
  emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-500",
  red: "border-red-500/20 bg-red-500/10 text-red-500",
  amber: "border-amber-500/20 bg-amber-500/10 text-amber-500",
  muted: "border-card-border bg-hover text-muted",
};

export default function StoragePage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState("pools");
  const [poolModal, setPoolModal] = useState(null); // {} = new, pool = edit, null = closed
  const [ruleModal, setRuleModal] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const poolsQ = useQuery({
    queryKey: ["vms-storage-pools"],
    queryFn: () => vms.storage.pools.list(),
  });
  const pools = useMemo(() => asItems(poolsQ.data), [poolsQ.data]);
  const poolNames = useMemo(() => {
    const m = {};
    for (const p of pools) m[p.id] = p.name;
    return m;
  }, [pools]);

  const rulesQ = useQuery({
    queryKey: ["vms-tier-rules"],
    queryFn: () => vms.storage.tierRules.list(),
  });
  const rules = useMemo(() => asItems(rulesQ.data), [rulesQ.data]);

  // RAID health — poll live while the tab is open (arrays change state slowly, so
  // 15s is plenty). Disabled off-tab so we don't shell mdadm needlessly.
  const raidQ = useQuery({
    queryKey: ["vms-raid-status"],
    queryFn: () => vms.storage.raid.status(),
    enabled: tab === "raid",
    refetchInterval: tab === "raid" ? 15_000 : false,
  });

  const removePool = useMutation({
    mutationFn: (id) => vms.storage.pools.remove(id),
    onSuccess: () => { toast.success("Pool deleted"); qc.invalidateQueries({ queryKey: ["vms-storage-pools"] }); },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });
  const removeRule = useMutation({
    mutationFn: (id) => vms.storage.tierRules.remove(id),
    onSuccess: () => { toast.success("Rule deleted"); qc.invalidateQueries({ queryKey: ["vms-tier-rules"] }); },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDeletePool = (pool) =>
    setConfirm({
      title: "Delete storage pool",
      message: `Delete "${pool.name}"? Recordings on it are not removed, but new writes stop. This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => { removePool.mutate(pool.id); setConfirm(null); },
    });
  const askDeleteRule = (rule) =>
    setConfirm({
      title: "Delete tier rule",
      message: `Delete "${rule.name}"? Existing tiered recordings stay where they are.`,
      confirmLabel: "Delete",
      onConfirm: () => { removeRule.mutate(rule.id); setConfirm(null); },
    });

  return (
    <div className="pb-8">
      <PageHeader
        title="Storage"
        subtitle="Recording pools, tiering and retention across local, NAS and cloud."
        actions={
          tab === "pools" ? (
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setPoolModal({})}>
              Add pool
            </Button>
          ) : tab === "rules" ? (
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setRuleModal({})}>
              Add rule
            </Button>
          ) : null
        }
      />

      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5" />

      {tab === "pools" ? (
        <PoolsTab
          pools={pools}
          query={poolsQ}
          onAdd={() => setPoolModal({})}
          onEdit={(p) => setPoolModal(p)}
          onDelete={askDeletePool}
        />
      ) : tab === "rules" ? (
        <RulesTab
          rules={rules}
          poolNames={poolNames}
          query={rulesQ}
          onAdd={() => setRuleModal({})}
          onEdit={(r) => setRuleModal(r)}
          onDelete={askDeleteRule}
        />
      ) : (
        <RaidTab query={raidQ} />
      )}

      {poolModal && (
        <StoragePoolModal
          pool={poolModal.id ? poolModal : null}
          onClose={() => setPoolModal(null)}
          onSuccess={() => setPoolModal(null)}
        />
      )}
      {ruleModal && (
        <TierRuleModal
          rule={ruleModal.id ? ruleModal : null}
          pools={pools}
          onClose={() => setRuleModal(null)}
          onSuccess={() => setRuleModal(null)}
        />
      )}
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={removePool.isPending || removeRule.isPending} />
    </div>
  );
}

// ── Pools tab ────────────────────────────────────────────────────────────
function PoolsTab({ pools, query, onAdd, onEdit, onDelete }) {
  const totalCap = pools.reduce((s, p) => s + (p.max_size_bytes || 0), 0);
  const defaultPool = pools.find((p) => p.is_default);

  if (query.isLoading) return <Loading label="Loading pools…" />;
  if (query.isError) return <ErrorBox error={query.error} fallback="Failed to load pools" />;
  if (pools.length === 0)
    return (
      <EmptyState
        icon="heroicons-outline:circle-stack"
        title="No storage pools"
        subtitle="Add a local, NAS or S3 pool to start recording."
        action={<Button variant="success" icon="heroicons-outline:plus" onClick={onAdd}>Add pool</Button>}
      />
    );

  return (
    <>
      <MetricRow
        className="mb-4"
        items={[
          { label: "Pools", value: pools.length, icon: "heroicons-outline:circle-stack", tone: "info" },
          { label: "Declared capacity", value: totalCap ? fmtBytes(totalCap) : "Unlimited", icon: "heroicons-outline:server-stack", tone: "neutral" },
          { label: "Default pool", value: defaultPool?.name || "None set", icon: "heroicons-outline:star", tone: defaultPool ? "ok" : "warn" },
        ]}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {pools.map((pool) => (
          <StoragePoolCard key={pool.id} pool={pool} onEdit={() => onEdit(pool)} onDelete={() => onDelete(pool)} />
        ))}
      </div>
    </>
  );
}

// ── Tier-rules tab ─────────────────────────────────────────────────────────
function RulesTab({ rules, poolNames, query, onAdd, onEdit, onDelete }) {
  if (query.isLoading) return <Loading label="Loading rules…" />;
  if (query.isError) return <ErrorBox error={query.error} fallback="Failed to load rules" />;
  if (rules.length === 0)
    return (
      <EmptyState
        icon="heroicons-outline:arrows-right-left"
        title="No tier rules"
        subtitle="Rules move recordings between pools as they age (hot → cold)."
        action={<Button variant="success" icon="heroicons-outline:plus" onClick={onAdd}>Add rule</Button>}
      />
    );

  const fmtAge = (h) => (h >= 24 ? `${Math.round(h / 24)}d (${h}h)` : `${h}h`);

  return (
    <div className="overflow-x-auto rounded-xl border border-card-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border bg-hover/40">
            <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Name</th>
            <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Flow</th>
            <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted">Move after</th>
            <th className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Status</th>
            <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-muted">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.id} className="border-b border-card-border/60 last:border-0 hover:bg-hover/50">
              <td className="px-4 py-3 font-medium text-foreground">{rule.name}</td>
              <td className="px-4 py-3 text-muted">
                <span className="inline-flex items-center gap-1.5">
                  {poolNames[rule.source_pool_id] || "—"}
                  <Icon icon="heroicons-outline:arrow-long-right" className="text-sm" />
                  {poolNames[rule.target_pool_id] || "—"}
                </span>
              </td>
              <td className="px-4 py-3 text-right tabular-nums text-muted">{fmtAge(rule.after_age_hours || 0)}</td>
              <td className="px-4 py-3">
                {rule.enabled ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Enabled
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full border border-card-border bg-hover px-2 py-0.5 text-[11px] text-muted">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted" /> Disabled
                  </span>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(rule)}
                    title="Edit"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-hover hover:text-foreground"
                  >
                    <Icon icon="heroicons-outline:pencil-square" className="text-base" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(rule)}
                    title="Delete"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 transition hover:bg-red-500/10"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-base" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── RAID tab ────────────────────────────────────────────────────────────────
// Software-RAID (mdadm) health. Enterprise-VMS parity: monitor arrays + alert on
// degrade so a failed disk is swapped before a second failure loses footage. The VMS
// does NOT build the array (OS/controller does) — it watches + reports.
function RaidTab({ query }) {
  if (query.isLoading) return <Loading label="Inspecting RAID arrays…" />;
  if (query.isError) return <ErrorBox error={query.error} fallback="Failed to load RAID status" />;

  const data = query.data || {};
  const arrays = data.arrays || [];

  // Host can't inspect software-RAID (non-Linux / mdadm absent) — honest banner.
  if (!data.available) {
    return (
      <div className="rounded-xl border border-card-border bg-card p-6">
        <div className="flex items-start gap-3">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 text-lg text-muted" />
          <div>
            <div className="text-sm font-medium text-foreground">RAID inspection not available on this host</div>
            <p className="mt-1 text-sm text-muted">
              {data.reason || "Software-RAID (mdadm) is not present on this node."}
            </p>
            <p className="mt-2 text-xs text-muted">
              On a Linux recording node with an mdadm array, arrays and their health appear here
              automatically, and a degraded array raises an alarm.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const degraded = arrays.filter((a) => a.health === "degraded" || a.health === "failed").length;
  const rebuilding = arrays.filter((a) => a.health === "rebuilding").length;

  return (
    <>
      <MetricRow
        className="mb-4"
        items={[
          { label: "Arrays", value: arrays.length, icon: "heroicons-outline:server-stack", tone: "info" },
          { label: "Degraded", value: degraded, icon: "heroicons-outline:exclamation-triangle", tone: degraded ? "bad" : "ok" },
          { label: "Rebuilding", value: rebuilding, icon: "heroicons-outline:arrow-path", tone: rebuilding ? "warn" : "neutral" },
        ]}
      />
      {arrays.length === 0 ? (
        <EmptyState
          icon="heroicons-outline:server-stack"
          title="No RAID arrays detected"
          subtitle="This node has no active software-RAID (mdadm) array."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {arrays.map((arr) => (
            <RaidArrayCard key={arr.device} arr={arr} />
          ))}
        </div>
      )}
    </>
  );
}

function RaidArrayCard({ arr }) {
  const h = RAID_HEALTH[arr.health] || RAID_HEALTH.unknown;
  const alarm = arr.health === "degraded" || arr.health === "failed";
  const pct = arr.rebuild_percent;
  return (
    <div className={`rounded-xl border bg-card p-4 ${alarm ? "border-red-500/30" : "border-card-border"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-sm font-medium text-foreground">
          <Icon icon="heroicons-outline:server-stack" className="text-base text-muted" />
          {arr.device}
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${RAID_TONE[h.tone]}`}>
          <Icon icon={h.icon} className="text-xs" /> {h.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-card-border bg-hover/40 py-2">
          <div className="text-sm font-semibold tabular-nums text-foreground">{(arr.level || "—").toUpperCase()}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Level</div>
        </div>
        <div className="rounded-lg border border-card-border bg-hover/40 py-2">
          <div className="text-sm font-semibold tabular-nums text-emerald-500">{arr.working_devices}/{arr.total_devices}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Working</div>
        </div>
        <div className="rounded-lg border border-card-border bg-hover/40 py-2">
          <div className={`text-sm font-semibold tabular-nums ${arr.failed_devices ? "text-red-500" : "text-foreground"}`}>
            {arr.failed_devices}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted">Failed</div>
        </div>
      </div>

      {arr.health === "rebuilding" && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted">
            <span>Rebuilding</span>
            {pct != null && <span className="tabular-nums">{pct}%</span>}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
            <div className="h-full rounded-full bg-amber-500 transition-all" style={{ width: `${pct ?? 30}%` }} />
          </div>
        </div>
      )}

      {alarm && (
        <p className="mt-3 text-xs text-red-500">
          Replace the failed disk and the array rebuilds automatically. Until then redundancy is lost.
        </p>
      )}
      {arr.state && (
        <p className="mt-2 truncate font-mono text-[10px] text-muted" title={arr.state}>{arr.state}</p>
      )}
    </div>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────
function Loading({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-xl border border-card-border bg-card py-20 text-sm text-muted">
      <Icon icon="svg-spinners:180-ring" className="text-base" /> {label}
    </div>
  );
}

function ErrorBox({ error, fallback }) {
  return (
    <div className="rounded-xl border border-red-500/20 bg-red-500/10 py-10 text-center text-sm text-red-500">
      {apiError(error, fallback)}
    </div>
  );
}
