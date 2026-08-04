"use client";

// VMS → Storage. Configure where recordings live and how they age:
//   • Pools — local / NFS / SMB / S3 targets with usage bars, default + active
//     toggles (CRUD).
//   • Tier rules — move recordings source → target after N hours (hot → cold).
//   • Retention overview — a read-out of per-pool caps + rule coverage.
// Ported from gvd_nvr's Storage page, reskinned to v3's dark tokens + the
// shared kit/common layer. Lives under Config → Storage.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, EmptyState, MetricRow, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, TabBar } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "./api";
import StoragePoolDetail from "./components/StoragePoolDetail";
import StoragePoolModal from "./components/StoragePoolModal";
import TierRuleModal from "./components/TierRuleModal";
import { POOL_TYPES } from "./constants";

const TYPE_ICON = Object.fromEntries(POOL_TYPES.map((t) => [t.value, t.icon]));

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
  emerald: "border-[rgba(34,211,238,.4)] bg-[rgba(34,211,238,.08)] text-nb-tealb",
  red: "border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] text-nb-crit",
  amber: "border-[rgba(251,191,36,.3)] bg-[rgba(251,191,36,.1)] text-nb-warn",
  muted: "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted",
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
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <TabBar tabs={TABS} active={tab} onChange={setTab} className="mb-5 shrink-0" />

      {tab === "pools" ? (
        <PoolsTab
          pools={pools}
          rules={rules}
          poolNames={poolNames}
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
        <div className="min-h-0 flex-1 overflow-y-auto scroll-themed">
          <RaidTab query={raidQ} />
        </div>
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

// ── Pools tab — master/detail (list + StoragePoolDetail), mirrors Sites ─────
function PoolListItem({ pool, selected, onSelect }) {
  const p = pool;
  const typeLabel = POOL_TYPES.find((t) => t.value === p.pool_type)?.label || p.pool_type;
  const loc =
    p.pool_type === "s3"
      ? p.s3_bucket || p.s3_endpoint || "—"
      : p.pool_type === "nfs" || p.pool_type === "smb"
        ? `${p.nas_server || "?"}:${p.nas_share || p.path || "?"}`
        : p.path || "—";
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 rounded-[10px] border px-4 py-3 text-left transition ${
          selected
            ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
            : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
        }`}
      >
        {selected && <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-nb-blue" />}
        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted shrink-0">
          <Icon icon={TYPE_ICON[p.pool_type] || "heroicons-outline:server"} className="text-base" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[#0c1530] ${
              p.is_active !== false ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-nb-ink truncate">{p.name}</span>
            {p.is_default && (
              <span className="text-[10px] rounded-full bg-[rgba(96,165,250,.1)] text-nb-blueb px-1.5 py-0.5 font-medium">
                Default
              </span>
            )}
          </span>
          <span className="block text-xs text-nb-soft truncate">{typeLabel}</span>
          <span className="block text-[10px] font-mono text-nb-faint truncate">{loc}</span>
        </span>
      </button>
    </li>
  );
}

function PoolsTab({ pools, rules, poolNames, query, onAdd, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return pools;
    return pools.filter((p) =>
      [p.name, p.path, p.s3_bucket, p.nas_server].filter(Boolean).join(" ").toLowerCase().includes(term),
    );
  }, [pools, search]);

  const selected = useMemo(() => pools.find((p) => p.id === selectedId) || null, [pools, selectedId]);

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const activeCount = pools.filter((p) => p.is_active !== false).length;

  const listActions = (
    <button
      onClick={onAdd}
      title="Add pool"
      className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)]"
    >
      <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
    </button>
  );

  return (
    <MasterDetail
      fill
      className="min-h-0 flex-1"
      aside={
        <ListPanel
          title="Pools"
          count={pools.length}
          action={listActions}
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search pools…"
        >
          <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
              <span className="text-nb-muted">{activeCount} active</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-nb-faint" />
              <span className="text-nb-muted">{pools.length - activeCount} inactive</span>
            </span>
          </div>

          {query.isLoading ? (
            <div className="px-4 py-8 flex items-center gap-2 text-sm text-nb-soft">
              <Spinner className="!h-4 !w-4" /> Loading…
            </div>
          ) : query.isError ? (
            <div className="px-4 py-6 text-center text-xs text-nb-crit">
              {apiError(query.error, "Failed to load pools")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(96,165,250,.1)]">
                <Icon icon="heroicons-outline:circle-stack" className="text-lg text-nb-muted" />
              </div>
              <div className="text-sm font-medium text-nb-ink">
                {search.trim() ? "No matches" : "No storage pools"}
              </div>
              <div className="mt-0.5 text-xs text-nb-muted">
                {search.trim() ? "Try a different keyword." : "Click Add to create your first pool."}
              </div>
            </div>
          ) : (
            <ul className="space-y-0.5 px-2 py-2">
              {filtered.map((p) => (
                <PoolListItem key={p.id} pool={p} selected={p.id === selectedId} onSelect={() => setSelectedId(p.id)} />
              ))}
            </ul>
          )}
        </ListPanel>
      }
    >
      <section className="rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] overflow-hidden min-h-0 flex flex-col">
        {selected ? (
          <StoragePoolDetail
            key={selected.id}
            pool={selected}
            rules={rules}
            poolNames={poolNames}
            onClose={() => setSelectedId(null)}
            onEdit={() => onEdit(selected)}
            onDelete={() => onDelete(selected)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(96,165,250,.1)] text-nb-muted">
              <Icon icon="heroicons-outline:circle-stack" className="text-xl" />
            </span>
            <div className="mt-3 text-sm font-semibold text-nb-ink">No pool selected</div>
            <div className="text-xs text-nb-muted mt-0.5">
              Pick one from the list, or click <b>Add</b> to create a new pool.
            </div>
          </div>
        )}
      </section>
    </MasterDetail>
  );
}

// ── Tier-rules tab — master/detail (list + detail), mirrors Pools ───────────
const fmtAge = (h) => (h >= 24 ? `${Math.round(h / 24)}d (${h}h)` : `${h}h`);

function TierInfoField({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{label}</div>
      <div className="mt-1 text-sm text-nb-ink">{children}</div>
    </div>
  );
}

function TierRuleListItem({ rule, poolNames, selected, onSelect }) {
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 rounded-[10px] border px-4 py-3 text-left transition ${
          selected
            ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)]"
            : "border-transparent hover:bg-[rgba(96,165,250,.06)]"
        }`}
      >
        {selected && <span className="absolute left-0 top-1 bottom-1 w-0.5 rounded bg-nb-blue" />}
        <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted shrink-0">
          <Icon icon="heroicons-outline:arrows-right-left" className="text-base" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[#0c1530] ${
              rule.enabled ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-nb-ink truncate">{rule.name}</span>
            {!rule.enabled && (
              <span className="text-[10px] rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] px-1.5 py-0.5 font-medium text-nb-muted">Disabled</span>
            )}
          </span>
          <span className="block text-xs text-nb-soft truncate">
            {poolNames[rule.source_pool_id] || "—"} → {poolNames[rule.target_pool_id] || "—"}
          </span>
          <span className="block text-[10px] font-mono text-nb-faint">after {fmtAge(rule.after_age_hours || 0)}</span>
        </span>
      </button>
    </li>
  );
}

function TierRuleDetail({ rule, poolNames, onClose, onEdit, onDelete }) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(96,165,250,.1)] text-nb-blueb shrink-0">
            <Icon icon="heroicons-outline:arrows-right-left" className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{rule.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              <span>after {fmtAge(rule.after_age_hours || 0)}</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  rule.enabled ? "bg-[rgba(52,211,153,.12)] text-nb-good" : "bg-[rgba(10,18,40,.6)] text-nb-muted"
                }`}
              >
                {rule.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onClose}
            title="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-xs text-nb-muted hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
          </button>
          <button
            onClick={onDelete}
            className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] px-2.5 py-1.5 text-xs text-nb-crit hover:bg-[rgba(248,113,113,.2)]"
          >
            <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-6">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted mb-2">Flow</div>
          <div className="flex items-center gap-3 rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] px-4 py-3">
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[10px] uppercase tracking-wide text-nb-muted">Source</div>
              <div className="mt-0.5 text-sm font-medium text-nb-ink truncate">
                {poolNames[rule.source_pool_id] || "—"}
              </div>
            </div>
            <Icon icon="heroicons-outline:arrow-long-right" className="text-lg text-nb-blueb shrink-0" />
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[10px] uppercase tracking-wide text-nb-muted">Target</div>
              <div className="mt-0.5 text-sm font-medium text-nb-ink truncate">
                {poolNames[rule.target_pool_id] || "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <TierInfoField label="Move after">{fmtAge(rule.after_age_hours || 0)}</TierInfoField>
          <TierInfoField label="Status">{rule.enabled ? "Enabled" : "Disabled"}</TierInfoField>
        </div>
      </div>
    </div>
  );
}

function RulesTab({ rules, poolNames, query, onAdd, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rules;
    return rules.filter((r) =>
      [r.name, poolNames[r.source_pool_id], poolNames[r.target_pool_id]]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term),
    );
  }, [rules, poolNames, search]);

  const selected = useMemo(() => rules.find((r) => r.id === selectedId) || null, [rules, selectedId]);

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const enabledCount = rules.filter((r) => r.enabled).length;

  const listActions = (
    <button
      onClick={onAdd}
      title="Add rule"
      className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.08)] px-3 text-[12.5px] tracking-[.4px] text-nb-tealb transition hover:shadow-[0_0_10px_rgba(34,211,238,.25)]"
    >
      <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
    </button>
  );

  return (
    <MasterDetail
      fill
      className="min-h-0 flex-1"
      aside={
        <ListPanel
          title="Tier Rules"
          count={rules.length}
          action={listActions}
          search={search}
          onSearch={setSearch}
          searchPlaceholder="Search rules…"
        >
          <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
              <span className="text-nb-muted">{enabledCount} enabled</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-nb-faint" />
              <span className="text-nb-muted">{rules.length - enabledCount} disabled</span>
            </span>
          </div>

          {query.isLoading ? (
            <div className="px-4 py-8 flex items-center gap-2 text-sm text-nb-soft">
              <Spinner className="!h-4 !w-4" /> Loading…
            </div>
          ) : query.isError ? (
            <div className="px-4 py-6 text-center text-xs text-nb-crit">
              {apiError(query.error, "Failed to load rules")}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(96,165,250,.1)]">
                <Icon icon="heroicons-outline:arrows-right-left" className="text-lg text-nb-muted" />
              </div>
              <div className="text-sm font-medium text-nb-ink">
                {search.trim() ? "No matches" : "No tier rules"}
              </div>
              <div className="mt-0.5 text-xs text-nb-muted">
                {search.trim()
                  ? "Try a different keyword."
                  : "Rules move recordings between pools as they age (hot → cold)."}
              </div>
            </div>
          ) : (
            <ul className="space-y-0.5 px-2 py-2">
              {filtered.map((r) => (
                <TierRuleListItem
                  key={r.id}
                  rule={r}
                  poolNames={poolNames}
                  selected={r.id === selectedId}
                  onSelect={() => setSelectedId(r.id)}
                />
              ))}
            </ul>
          )}
        </ListPanel>
      }
    >
      <section className="rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] overflow-hidden min-h-0 flex flex-col">
        {selected ? (
          <TierRuleDetail
            key={selected.id}
            rule={selected}
            poolNames={poolNames}
            onClose={() => setSelectedId(null)}
            onEdit={() => onEdit(selected)}
            onDelete={() => onDelete(selected)}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(96,165,250,.1)] text-nb-muted">
              <Icon icon="heroicons-outline:arrows-right-left" className="text-xl" />
            </span>
            <div className="mt-3 text-sm font-semibold text-nb-ink">No rule selected</div>
            <div className="text-xs text-nb-muted mt-0.5">
              Pick one from the list, or click <b>Add</b> to create a new rule.
            </div>
          </div>
        )}
      </section>
    </MasterDetail>
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
      <div className="rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] p-6">
        <div className="flex items-start gap-3">
          <Icon icon="heroicons-outline:information-circle" className="mt-0.5 text-lg text-nb-muted" />
          <div>
            <div className="text-sm font-medium text-nb-ink">RAID inspection not available on this host</div>
            <p className="mt-1 text-sm text-nb-soft">
              {data.reason || "Software-RAID (mdadm) is not present on this node."}
            </p>
            <p className="mt-2 text-xs text-nb-muted">
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
    <div className={`rounded-[14px] border bg-[rgba(8,15,34,.5)] p-4 ${alarm ? "border-[rgba(248,113,113,.3)]" : "border-nb-line"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-sm font-medium text-nb-ink">
          <Icon icon="heroicons-outline:server-stack" className="text-base text-nb-muted" />
          {arr.device}
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${RAID_TONE[h.tone]}`}>
          <Icon icon={h.icon} className="text-xs" /> {h.label}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-2">
          <div className="text-sm font-semibold tabular-nums text-nb-ink">{(arr.level || "—").toUpperCase()}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-nb-muted">Level</div>
        </div>
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-2">
          <div className="text-sm font-semibold tabular-nums text-nb-good">{arr.working_devices}/{arr.total_devices}</div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-nb-muted">Working</div>
        </div>
        <div className="rounded-lg border border-nb-line bg-[rgba(10,18,40,.6)] py-2">
          <div className={`text-sm font-semibold tabular-nums ${arr.failed_devices ? "text-nb-crit" : "text-nb-ink"}`}>
            {arr.failed_devices}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wide text-nb-muted">Failed</div>
        </div>
      </div>

      {arr.health === "rebuilding" && (
        <div className="mt-3">
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
        <p className="mt-3 text-xs text-nb-crit">
          Replace the failed disk and the array rebuilds automatically. Until then redundancy is lost.
        </p>
      )}
      {arr.state && (
        <p className="mt-2 truncate font-mono text-[10px] text-nb-faint" title={arr.state}>{arr.state}</p>
      )}
    </div>
  );
}

// ── Small shared bits ──────────────────────────────────────────────────────
function Loading({ label }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-[14px] border border-nb-line bg-[rgba(8,15,34,.5)] py-20 text-sm text-nb-soft">
      <Icon icon="svg-spinners:180-ring" className="text-base" /> {label}
    </div>
  );
}

function ErrorBox({ error, fallback }) {
  return (
    <div className="rounded-[14px] border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] py-10 text-center text-sm text-nb-crit">
      {apiError(error, fallback)}
    </div>
  );
}
