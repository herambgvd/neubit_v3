"use client";

// Right-pane detail for one NVR: header (name, host, status) + a health panel
// (GET /vms/nvrs/{id}/health — reachability, channel/mapped counts, storage) + the
// mapped channel-cameras list, with actions to map channels, refresh, edit, delete.
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative, titleize } from "@/lib/format";
import { vms } from "../api";
import StatusBadge from "./StatusBadge";

function InfoCell({ label, value }) {
  return (
    <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 truncate text-sm text-foreground">{value ?? "—"}</p>
    </div>
  );
}

export default function NvrDetail({ nvr, siteNames = {}, onMapChannels, onEdit, onDelete }) {
  const qc = useQueryClient();

  const healthQ = useQuery({
    queryKey: ["nvr-health", nvr.id],
    queryFn: () => vms.nvrs.health(nvr.id),
    refetchInterval: 30_000,
  });
  const health = healthQ.data;

  // Channel-cameras belonging to this NVR (mapped channels are cameras with nvr_id).
  const camsQ = useQuery({
    queryKey: ["nvr-cams", nvr.id],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 15_000,
  });
  const channelCams = useMemo(
    () => asItems(camsQ.data).filter((c) => c.nvr_id === nvr.id),
    [camsQ.data, nvr.id],
  );

  const refresh = useMutation({
    mutationFn: () => vms.nvrs.refresh(nvr.id),
    onSuccess: () => {
      toast.success("NVR re-probed");
      qc.invalidateQueries({ queryKey: ["vms-nvrs"] });
      qc.invalidateQueries({ queryKey: ["nvr-health", nvr.id] });
    },
    onError: (e) => toast.error(apiError(e, "Refresh failed")),
  });

  const storage = health?.storage_info || nvr.storage_info || {};

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
            <Icon icon="heroicons-outline:server-stack" className="text-lg" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-foreground">{nvr.name}</h1>
            <p className="truncate font-mono text-[11px] text-muted">
              {titleize(nvr.brand)} · {nvr.host}:{nvr.port}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={nvr.status} />
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Re-probe" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
            <Icon icon={refresh.isPending ? "svg-spinners:180-ring" : "heroicons-outline:arrow-path"} className="text-sm" />
          </button>
          <Button variant="secondary" className="!px-2.5 !py-1.5 !text-xs" icon="heroicons-outline:pencil-square" onClick={() => onEdit?.(nvr)}>Edit</Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs !text-red-500" icon="heroicons-outline:trash" onClick={() => onDelete?.(nvr)}>Delete</Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {nvr.last_error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-500">{nvr.last_error}</div>
        )}

        {/* Health grid */}
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={titleize(health?.status || nvr.status)} />
          <InfoCell label="Channels" value={health?.channel_count ?? nvr.channel_count} />
          <InfoCell label="Mapped" value={health?.mapped_channel_count ?? channelCams.length} />
          <InfoCell label="Last seen" value={nvr.last_seen_at ? fmtRelative(nvr.last_seen_at) : "—"} />
          {storage.total_gb != null && <InfoCell label="Storage total" value={`${storage.total_gb} GB`} />}
          {storage.used_gb != null && <InfoCell label="Storage used" value={`${storage.used_gb} GB`} />}
        </div>

        {/* Mapped channel-cameras */}
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Mapped channels ({channelCams.length})</p>
          <Button variant="secondary" className="!px-2.5 !py-1 !text-xs" icon="heroicons-outline:queue-list" onClick={() => onMapChannels?.(nvr)}>
            Map channels
          </Button>
        </div>

        {channelCams.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-8 text-center text-xs text-muted">
            No channels mapped yet — click “Map channels” to expose recorder channels as cameras.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-card-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-card-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-medium">Ch</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Site</th>
                </tr>
              </thead>
              <tbody>
                {channelCams
                  .slice()
                  .sort((a, b) => (a.nvr_channel_number ?? 0) - (b.nvr_channel_number ?? 0))
                  .map((c) => (
                    <tr key={c.id} className="border-b border-card-border last:border-0">
                      <td className="px-3 py-2 text-muted">{c.nvr_channel_number ?? "—"}</td>
                      <td className="px-3 py-2 text-foreground">{c.name}</td>
                      <td className="px-3 py-2"><StatusBadge status={c.status} /></td>
                      <td className="px-3 py-2 text-muted">{siteNames[c.placement?.site_id] || "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
