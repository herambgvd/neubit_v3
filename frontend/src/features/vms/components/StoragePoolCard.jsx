"use client";

// A single storage-pool card — type icon, name, default/active pills, path or
// NAS/S3 endpoint, a usage bar (from GET /storage/pools/{id}/usage), and
// edit/delete actions. Ported from gvd_nvr's Storage PoolCard, reskinned to v3.
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { fmtBytes } from "@/lib/format";
import { vms } from "../api";
import { POOL_TYPES } from "../constants";

const TYPE_ICON = Object.fromEntries(POOL_TYPES.map((t) => [t.value, t.icon]));

export default function StoragePoolCard({ pool, onEdit, onDelete }) {
  // Live usage — capacity/used/recording_count. Cheap to poll occasionally.
  const usageQ = useQuery({
    queryKey: ["vms-pool-usage", pool.id],
    queryFn: () => vms.storage.pools.usage(pool.id),
    refetchInterval: 30_000,
    retry: false,
  });
  const usage = usageQ.data || {};

  // Prefer the REAL volume stats (cross-platform disk_usage — Windows drive / Linux
  // mount); fall back to recorded-bytes vs configured max for remote pools (NAS/S3)
  // where the local filesystem view isn't the truth.
  const hasDisk = usage.disk_reachable && usage.disk_total_bytes > 0;
  const capacity = hasDisk ? usage.disk_total_bytes : usage.capacity_bytes ?? pool.max_size_bytes ?? 0;
  const used = hasDisk ? usage.disk_used_bytes : usage.bytes_used ?? usage.used_bytes ?? 0;
  const free = hasDisk ? usage.disk_free_bytes : capacity > 0 ? capacity - used : 0;
  const usedPct = hasDisk
    ? usage.disk_percent_used ?? 0
    : capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0;
  const barColor = usedPct > 90 ? "bg-red-500" : usedPct > 70 ? "bg-amber-500" : "bg-blue-500";

  const isObject = pool.pool_type === "s3";
  const isNas = pool.pool_type === "nfs" || pool.pool_type === "smb";
  const reachable = pool.reachable ?? (pool.mount_state === "mounted");

  return (
    <div className="rounded-xl border border-card-border bg-card p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon icon={TYPE_ICON[pool.pool_type] || "heroicons-outline:server"} className="shrink-0 text-base text-muted" />
          <span className="truncate font-medium text-foreground">{pool.name}</span>
          {pool.is_default && (
            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
              Default
            </span>
          )}
          {pool.is_active === false && (
            <span className="rounded-full border border-card-border bg-hover px-2 py-0.5 text-[10px] font-medium text-muted">
              Inactive
            </span>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5">
          <button
            type="button"
            onClick={onEdit}
            title="Edit"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Delete"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-red-500 transition hover:bg-red-500/10"
          >
            <Icon icon="heroicons-outline:trash" className="text-sm" />
          </button>
        </div>
      </div>

      <p className="mb-1 truncate text-[11px] text-muted" title={pool.path || pool.s3_bucket}>
        {isObject
          ? `${pool.s3_endpoint || "s3"} / ${pool.s3_bucket || "—"}`
          : isNas
            ? `${pool.nas_server || "?"}:${pool.nas_share || pool.path || "?"}`
            : pool.path || "—"}
      </p>
      <p className="mb-3 text-[11px] text-muted">
        {POOL_TYPES.find((t) => t.value === pool.pool_type)?.label || pool.pool_type}
        {" · priority "}{pool.priority ?? 0}
        {usage.recording_count != null && ` · ${usage.recording_count} recordings`}
      </p>

      {(isNas || isObject) && (
        <div className="mb-3 flex items-center gap-1.5 text-[11px]">
          <span className={`inline-block h-2 w-2 rounded-full ${reachable ? "bg-emerald-500" : "bg-muted"}`} />
          <span className={reachable ? "text-emerald-500" : "text-muted"}>
            {reachable ? "Reachable" : pool.mount_state || "Unreachable"}
          </span>
        </div>
      )}

      {capacity > 0 ? (
        <>
          <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-hover">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${usedPct}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-muted">
            <span>{fmtBytes(used)} used</span>
            {hasDisk && <span className="text-foreground">{fmtBytes(free)} free</span>}
            <span>{fmtBytes(capacity)} total</span>
          </div>
        </>
      ) : (
        <div className="text-[11px] text-muted">{fmtBytes(used)} used · unlimited</div>
      )}

      {usedPct > 90 && (
        <div className="mt-3 flex items-center gap-1 text-[11px] text-red-500">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-xs" /> Storage nearly full
        </div>
      )}
    </div>
  );
}
