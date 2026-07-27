"use client";

// Right-pane detail for a selected storage pool: header (type icon, name, default/
// active/reachable pills + close/edit/delete), a live usage bar, a config info
// grid, and the tier rules that reference this pool. Usage polls GET
// /storage/pools/{id}/usage. Mirrors SiteDetail's shape.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { fmtBytes } from "@/lib/format";
import { vms } from "../api";
import { POOL_TYPES } from "../constants";

const TYPE_ICON = Object.fromEntries(POOL_TYPES.map((t) => [t.value, t.icon]));

function InfoField({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{label}</div>
      <div className="mt-1 text-sm text-nb-ink">{children}</div>
    </div>
  );
}

export default function StoragePoolDetail({ pool, rules = [], poolNames = {}, onClose, onEdit, onDelete }) {
  const usageQ = useQuery({
    queryKey: ["vms-pool-usage", pool.id],
    queryFn: () => vms.storage.pools.usage(pool.id),
    refetchInterval: 30_000,
    retry: false,
  });
  const usage = usageQ.data || {};

  const capacity = usage.capacity_bytes ?? pool.max_size_bytes ?? 0;
  const used = usage.used_bytes ?? 0;
  const usedPct = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  const barColor =
    usedPct > 90
      ? "bg-gradient-to-r from-nb-warn to-nb-crit"
      : usedPct > 70
        ? "bg-gradient-to-r from-nb-warn to-nb-warn"
        : "bg-gradient-to-r from-nb-blue to-nb-teal";

  const isObject = pool.pool_type === "s3";
  const isNas = pool.pool_type === "nfs" || pool.pool_type === "smb";
  const reachable = pool.reachable ?? pool.mount_state === "mounted";
  const typeLabel = POOL_TYPES.find((t) => t.value === pool.pool_type)?.label || pool.pool_type;
  const location = isObject
    ? `${pool.s3_endpoint || "s3"} / ${pool.s3_bucket || "—"}`
    : isNas
      ? `${pool.nas_server || "?"}:${pool.nas_share || pool.path || "?"}`
      : pool.path || "—";

  const relatedRules = rules.filter((r) => r.source_pool_id === pool.id || r.target_pool_id === pool.id);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(96,165,250,.1)] text-nb-blueb shrink-0">
            <Icon icon={TYPE_ICON[pool.pool_type] || "heroicons-outline:server"} className="text-2xl" />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{pool.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              <span>{typeLabel}</span>
              {pool.is_default && (
                <span className="rounded-full bg-[rgba(96,165,250,.1)] text-nb-blueb px-2 py-0.5 font-medium">Default</span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  pool.is_active !== false ? "bg-[rgba(52,211,153,.12)] text-nb-good" : "bg-[rgba(10,18,40,.6)] text-nb-muted"
                }`}
              >
                {pool.is_active !== false ? "Active" : "Inactive"}
              </span>
              {(isNas || isObject) && (
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    reachable ? "bg-[rgba(34,211,238,.1)] text-nb-tealb" : "bg-[rgba(10,18,40,.6)] text-nb-muted"
                  }`}
                >
                  {reachable ? "Reachable" : pool.mount_state || "Unreachable"}
                </span>
              )}
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
        {/* Usage */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted mb-2">Usage</div>
          {capacity > 0 ? (
            <>
              <div className="mb-2 h-2 overflow-hidden rounded-full border border-nb-line bg-black/40">
                <div className={`h-full rounded-full ${barColor}`} style={{ width: `${usedPct}%` }} />
              </div>
              <div className="flex justify-between text-xs text-nb-soft">
                <span>{fmtBytes(used)} used</span>
                <span>{fmtBytes(capacity)} total</span>
              </div>
            </>
          ) : (
            <div className="text-sm text-nb-soft">{fmtBytes(used)} used · unlimited</div>
          )}
          {usedPct > 90 && (
            <div className="mt-2 flex items-center gap-1 text-xs text-nb-crit">
              <Icon icon="heroicons-outline:exclamation-triangle" className="text-xs" /> Storage nearly full
            </div>
          )}
        </div>

        {/* Config */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <InfoField label="Type">{typeLabel}</InfoField>
          <InfoField label="Location">
            <span className="font-mono text-[13px] break-all text-nb-faint">{location}</span>
          </InfoField>
          <InfoField label="Priority">{pool.priority ?? 0}</InfoField>
          <InfoField label="Recordings">{usage.recording_count != null ? usage.recording_count : "—"}</InfoField>
          <InfoField label="Default pool">{pool.is_default ? "Yes" : "No"}</InfoField>
          <InfoField label="Status">{pool.is_active !== false ? "Active" : "Inactive"}</InfoField>
        </div>

        {/* Tier rules referencing this pool */}
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted mb-2">Tier rules</div>
          {relatedRules.length === 0 ? (
            <p className="text-sm text-nb-soft">No tier rules reference this pool.</p>
          ) : (
            <div className="space-y-2">
              {relatedRules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2 rounded-lg border border-nb-line bg-[rgba(8,15,34,.5)] px-3 py-2 text-sm"
                >
                  <span className="font-medium text-nb-ink">{r.name}</span>
                  <span className="inline-flex items-center gap-1 text-xs text-nb-soft">
                    {poolNames[r.source_pool_id] || "—"}
                    <Icon icon="heroicons-outline:arrow-long-right" className="text-sm" />
                    {poolNames[r.target_pool_id] || "—"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
