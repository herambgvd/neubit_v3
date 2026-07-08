"use client";

// NVR channel mapping — enumerate a SAVED NVR's channels
// (GET /vms/nvrs/{id}/channels), tick the ones to expose as cameras, name them and
// optionally assign a site, then POST /vms/nvrs/{id}/map-channels to create a
// channel-camera per selection (idempotent — already-mapped channels are skipped).
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@iconify/react";

import { Button, Modal, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { vms } from "../api";

export default function ChannelMappingModal({ nvr, sites = [], onClose, onSuccess }) {
  const [selected, setSelected] = useState({}); // channel → { checked, name }
  const [targetSite, setTargetSite] = useState("");

  const channelsQ = useQuery({
    queryKey: ["nvr-channels", nvr.id],
    queryFn: () => vms.nvrs.channels(nvr.id),
  });
  const channels = asItems(channelsQ.data);

  useEffect(() => {
    if (!channels.length) return;
    setSelected((prev) => {
      if (Object.keys(prev).length) return prev;
      const sel = {};
      for (const c of channels) sel[c.channel] = { checked: true, name: c.name || `Channel ${c.channel}` };
      return sel;
    });
  }, [channels]);

  const map = useMutation({
    mutationFn: () => {
      const list = channels.map((c) => ({
        channel_number: c.channel_number ?? c.channel,
        name: selected[c.channel]?.name || c.name,
        profile_token: c.source_token || undefined,
        add: !!selected[c.channel]?.checked,
        site_id: targetSite || undefined,
      }));
      return vms.nvrs.mapChannels(nvr.id, list);
    },
    onSuccess: (res) => {
      const created = res?.created_count ?? (Array.isArray(res?.created) ? res.created.length : 0);
      const skipped = res?.skipped_count ?? 0;
      toast.success(`Mapped ${created} channel(s)${skipped ? ` · ${skipped} already mapped` : ""}`);
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Mapping failed")),
  });

  const selectedCount = channels.filter((c) => selected[c.channel]?.checked).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Map channels — ${nvr.name}`}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => map.mutate()} disabled={selectedCount === 0 || map.isPending}>
            {map.isPending ? "Mapping…" : `Map ${selectedCount} channel${selectedCount === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      {channelsQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Enumerating channels…
        </div>
      ) : channelsQ.isError ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-4 text-center text-sm text-red-500">
          {apiError(channelsQ.error, "Could not enumerate channels — is the NVR reachable?")}
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-card-border px-4 py-10 text-center text-sm text-muted">
          No channels reported by this NVR.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">{selectedCount} of {channels.length} channel(s) selected</p>
            <Field
              as="select"
              value={targetSite}
              onChange={(e) => setTargetSite(e.target.value)}
              options={[{ value: "", label: "— No site —" }, ...sites.map((s) => ({ value: s.site_id, label: s.name }))]}
              containerClassName="w-48"
            />
          </div>
          <div className="max-h-80 space-y-1.5 overflow-y-auto rounded-lg border border-card-border p-2">
            {channels.map((c) => {
              const s = selected[c.channel] || {};
              return (
                <div key={c.channel} className="flex items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2">
                  <Toggle checked={!!s.checked} onChange={(v) => setSelected((prev) => ({ ...prev, [c.channel]: { ...prev[c.channel], checked: v } }))} />
                  <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded bg-hover text-[11px] font-semibold text-muted">
                    {c.channel_number ?? c.channel}
                  </div>
                  <input
                    value={s.name || ""}
                    onChange={(e) => setSelected((prev) => ({ ...prev, [c.channel]: { ...prev[c.channel], name: e.target.value } }))}
                    placeholder={c.name || `Channel ${c.channel}`}
                    className="h-9 flex-1 rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
                  />
                  {c.main?.resolution && <span className="shrink-0 text-[11px] text-muted">{c.main.resolution}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
