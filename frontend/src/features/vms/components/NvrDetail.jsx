"use client";

// Right-pane detail for one NVR: header (name, host, status) + a health panel
// (GET /vms/nvrs/{id}/health) + an INLINE channel list with an ON/OFF toggle per
// channel. Toggling ON maps that recorder channel as a camera (POST
// /vms/nvrs/{id}/map-channels, add:true); OFF deletes the channel-camera. No modal /
// "Map channels" click needed — the toggle IS the mapping. A "Bulk map" button still
// opens the full modal (naming + site assignment) for onboarding many at once.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Toggle } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { asItems, fmtRelative, titleize } from "@/lib/format";
import { vms } from "../api";
import StatusBadge from "./StatusBadge";

function InfoCell({ label, value }) {
  return (
    <div className="rounded-lg border border-card-border bg-hover/40 px-3 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-medium text-foreground">{value ?? "—"}</p>
    </div>
  );
}

export default function NvrDetail({ nvr, siteNames = {}, onMapChannels, onEdit, onDelete }) {
  const qc = useQueryClient();
  const [busyCh, setBusyCh] = useState({}); // channel_number → true while toggling

  const healthQ = useQuery({
    queryKey: ["nvr-health", nvr.id],
    queryFn: () => vms.nvrs.health(nvr.id),
    refetchInterval: 30_000,
  });
  const health = healthQ.data;

  // Channel-cameras belonging to this NVR (a mapped channel IS a camera with nvr_id).
  const camsQ = useQuery({
    queryKey: ["nvr-cams", nvr.id],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    staleTime: 5_000,
    // A freshly-mapped channel-camera is created as "connecting" and only flips to
    // online/offline on the next backend health sample (~45s). Poll while ANY of this
    // NVR's channels is still "connecting" so the status badge self-resolves instead
    // of sitting on a stale "Connecting" until the user manually refreshes.
    refetchInterval: (q) => {
      const cams = asItems(q.state.data).filter((c) => c.nvr_id === nvr.id);
      return cams.some((c) => c.status === "connecting") ? 5_000 : false;
    },
  });
  const channelCams = useMemo(
    () => asItems(camsQ.data).filter((c) => c.nvr_id === nvr.id),
    [camsQ.data, nvr.id],
  );

  // Every channel the NVR reports — the toggle list is built from this. Served from
  // the NVR row's cached channel list (backend caches the ONVIF enumeration), so it
  // loads instantly on every visit and does NOT silently re-run the slow enumeration
  // on each browser refresh; the ↻ button (below) forces a live re-enumeration.
  const channelsQ = useQuery({
    queryKey: ["nvr-enum-channels", nvr.id],
    queryFn: () => vms.nvrs.channels(nvr.id),
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
  const [reEnumerating, setReEnumerating] = useState(false);
  const reEnumerate = async () => {
    setReEnumerating(true);
    try {
      const data = await vms.nvrs.channels(nvr.id, { refresh: true });
      qc.setQueryData(["nvr-enum-channels", nvr.id], data);
    } catch (e) {
      toast.error(apiError(e, "Could not re-enumerate channels — is the NVR reachable?"));
    } finally {
      setReEnumerating(false);
    }
  };
  const enumChannels = useMemo(() => asItems(channelsQ.data), [channelsQ.data]);

  // channel_number → its mapped camera (if any). Drives each toggle's on/off state.
  const camByChannel = useMemo(() => {
    const m = {};
    for (const c of channelCams) if (c.nvr_channel_number != null) m[c.nvr_channel_number] = c;
    return m;
  }, [channelCams]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["nvr-cams", nvr.id] });
    qc.invalidateQueries({ queryKey: ["vms-cameras"] });
    qc.invalidateQueries({ queryKey: ["nvr-health", nvr.id] });
    qc.invalidateQueries({ queryKey: ["vms-nvrs"] });
  };

  // Toggle a single channel on (map → create camera) or off (unmap → delete camera).
  const toggleChannel = async (ch, on) => {
    const chNo = ch.channel_number ?? ch.channel;
    setBusyCh((b) => ({ ...b, [chNo]: true }));
    try {
      if (on) {
        await vms.nvrs.mapChannels(nvr.id, [
          {
            channel_number: chNo,
            name: ch.name || `Channel ${chNo}`,
            profile_token: ch.source_token || ch.profile_token || undefined,
            add: true,
          },
        ]);
        toast.success(`Channel ${chNo} is now a camera`);
      } else {
        const cam = camByChannel[chNo];
        if (cam) {
          await vms.cameras.remove(cam.id);
          toast.success(`Channel ${chNo} removed`);
        }
      }
      invalidate();
    } catch (e) {
      toast.error(apiError(e, "Could not update channel"));
    } finally {
      setBusyCh((b) => ({ ...b, [chNo]: false }));
    }
  };

  const refresh = useMutation({
    mutationFn: () => vms.nvrs.refresh(nvr.id),
    onSuccess: () => {
      toast.success("NVR re-probed");
      qc.invalidateQueries({ queryKey: ["vms-nvrs"] });
      qc.invalidateQueries({ queryKey: ["nvr-health", nvr.id] });
      reEnumerate();
    },
    onError: (e) => toast.error(apiError(e, "Refresh failed")),
  });

  const storage = health?.storage_info || nvr.storage_info || {};
  const sortedChannels = useMemo(
    () =>
      enumChannels
        .slice()
        .sort((a, b) => (a.channel_number ?? a.channel ?? 0) - (b.channel_number ?? b.channel ?? 0)),
    [enumChannels],
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-500">
            <Icon icon="heroicons-outline:server-stack" className="text-base" />
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

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto p-3">
        {nvr.last_error && (
          <div className="mb-3 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-[11px] text-red-500">{nvr.last_error}</div>
        )}

        {/* Health grid */}
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InfoCell label="Status" value={titleize(health?.status || nvr.status)} />
          <InfoCell label="Channels" value={health?.channel_count ?? nvr.channel_count} />
          <InfoCell label="On (cameras)" value={channelCams.length} />
          <InfoCell label="Last seen" value={nvr.last_seen_at ? fmtRelative(nvr.last_seen_at) : "—"} />
          {storage.total_gb != null && <InfoCell label="Storage total" value={`${storage.total_gb} GB`} />}
          {storage.used_gb != null && <InfoCell label="Storage used" value={`${storage.used_gb} GB`} />}
        </div>

        {/* Inline channel toggles */}
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
            Channels ({sortedChannels.length}){" "}
            <span className="text-emerald-500">· {channelCams.length} on</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={reEnumerate}
              disabled={reEnumerating || channelsQ.isFetching}
              title="Re-enumerate channels from device"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
            >
              <Icon
                icon={reEnumerating || channelsQ.isFetching ? "svg-spinners:180-ring" : "heroicons-outline:arrow-path"}
                className="text-sm"
              />
            </button>
            <Button variant="secondary" className="!px-2.5 !py-1 !text-xs" icon="heroicons-outline:queue-list" onClick={() => onMapChannels?.(nvr)}>
              Bulk map
            </Button>
          </div>
        </div>

        {channelsQ.isLoading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-card-border py-10 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-base" /> Enumerating channels…
          </div>
        ) : channelsQ.isError ? (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-4 text-center text-xs text-red-500">
            {apiError(channelsQ.error, "Could not enumerate channels — is the NVR reachable?")}
          </div>
        ) : sortedChannels.length === 0 ? (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-8 text-center text-xs text-muted">
            No channels reported by this NVR. Check credentials / ONVIF port, then Refresh.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-card-border">
            {sortedChannels.map((ch, i) => {
              const chNo = ch.channel_number ?? ch.channel;
              const cam = camByChannel[chNo];
              const on = !!cam;
              const busy = !!busyCh[chNo];
              return (
                <div
                  key={chNo ?? i}
                  className={`flex items-center gap-3 px-3 py-2 ${i ? "border-t border-card-border/50" : ""} ${on ? "bg-emerald-500/[0.04]" : ""}`}
                >
                  <span className="inline-flex h-7 w-9 shrink-0 items-center justify-center rounded bg-hover text-[11px] font-semibold tabular-nums text-muted">
                    {chNo}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {cam?.name || ch.name || `Channel ${chNo}`}
                    </p>
                    {(ch.main?.resolution || cam?.status) && (
                      <p className="truncate text-[11px] text-muted">
                        {ch.main?.resolution || ""}
                        {cam ? `${ch.main?.resolution ? " · " : ""}${siteNames[cam.placement?.site_id] || ""}` : ""}
                      </p>
                    )}
                  </div>
                  {on && <StatusBadge status={cam.status} />}
                  {busy ? (
                    <Icon icon="svg-spinners:180-ring" className="text-base text-muted" />
                  ) : (
                    <Toggle checked={on} onChange={(v) => toggleChannel(ch, v)} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          Toggle a channel <span className="text-emerald-500">on</span> to expose it as a camera; toggle off to remove it.
        </p>
      </div>
    </section>
  );
}
