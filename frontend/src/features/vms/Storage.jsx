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
];

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
          ) : (
            <Button variant="success" icon="heroicons-outline:plus" onClick={() => setRuleModal({})}>
              Add rule
            </Button>
          )
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
      ) : (
        <RulesTab
          rules={rules}
          poolNames={poolNames}
          query={rulesQ}
          onAdd={() => setRuleModal({})}
          onEdit={(r) => setRuleModal(r)}
          onDelete={askDeleteRule}
        />
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
