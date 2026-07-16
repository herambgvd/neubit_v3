"use client";

// VMS → NVR. Recorder estate as a master/detail: LEFT = onboarded NVRs (search +
// Add + Discover + online counts), RIGHT = NvrDetail (health + mapped channels +
// map/edit/delete). Mirrors the Access-Control master/detail structure, rethemed.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems, titleize } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { vms } from "./api";
import StatusBadge from "./components/StatusBadge";
import AddNvrModal from "./components/AddNvrModal";
import NvrDiscoveryModal from "./components/NvrDiscoveryModal";
import ChannelMappingModal from "./components/ChannelMappingModal";
import NvrDetail from "./components/NvrDetail";

export default function NvrPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [mapTarget, setMapTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const nvrsQ = useQuery({
    queryKey: ["vms-nvrs"],
    queryFn: () => vms.nvrs.list({ limit: 500 }),
    refetchInterval: 20_000,
  });
  const nvrs = useMemo(() => asItems(nvrsQ.data), [nvrsQ.data]);

  const sitesQ = useQuery({ queryKey: ["sites-list"], queryFn: () => sitesApi.list({ limit: 200 }), staleTime: 60_000 });
  const sites = asItems(sitesQ.data);
  const siteNames = useMemo(() => {
    const m = {};
    for (const s of sites) m[s.site_id] = s.name;
    return m;
  }, [sites]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return nvrs;
    return nvrs.filter((n) => n.name?.toLowerCase().includes(term) || n.host?.toLowerCase().includes(term));
  }, [nvrs, search]);

  const selected = useMemo(() => nvrs.find((n) => n.id === selectedId) || null, [nvrs, selectedId]);

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const onlineCount = nvrs.filter((n) => n.status === "online").length;

  const remove = useMutation({
    mutationFn: (id) => vms.nvrs.remove(id),
    onSuccess: (_d, id) => {
      toast.success("NVR removed");
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["vms-nvrs"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  const askDelete = (nvr) =>
    setConfirm({
      title: "Delete NVR",
      message: `Remove ${nvr.name}? Its mapped channel-cameras remain but lose their NVR link. This cannot be undone.`,
      confirmLabel: "Delete",
      onConfirm: () => { remove.mutate(nvr.id); setConfirm(null); },
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title="NVRs"
            icon="heroicons-outline:server-stack"
            count={nvrs.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name or host…"
            action={
              <div className="flex items-center gap-1">
                <button onClick={() => qc.invalidateQueries({ queryKey: ["vms-nvrs"] })} title="Refresh" className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
                  <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                </button>
                <button onClick={() => setDiscoverOpen(true)} title="Discover NVRs" className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted hover:bg-hover hover:text-foreground">
                  <Icon icon="heroicons-outline:magnifying-glass" className="text-sm" />
                </button>
                <button onClick={() => setAddOpen(true)} title="Add NVR" className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500">
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="text-muted">{onlineCount} online</span></span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-muted" /><span className="text-muted">{nvrs.length - onlineCount} offline</span></span>
            </div>

            {nvrsQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-muted"><Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />Loading…</div>
            ) : nvrsQ.isError ? (
              <div className="px-4 py-6 text-center text-xs text-red-500">{apiError(nvrsQ.error, "Failed to load NVRs")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted">{nvrs.length === 0 ? "No NVRs yet — Add or Discover one." : "No matches."}</div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((n) => {
                  const isSel = selectedId === n.id;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setSelectedId(n.id)}
                      className={`relative block w-full rounded-lg border px-3 py-2.5 text-left transition ${isSel ? "border-foreground bg-hover" : "border-card-border hover:bg-hover"}`}
                    >
                      {isSel && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l bg-blue-500" />}
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-semibold text-foreground">{n.name}</p>
                        <StatusBadge status={n.status} />
                      </div>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{titleize(n.brand)} · {n.host}:{n.port}</p>
                      <p className="mt-0.5 text-[10px] text-muted/70">{n.channel_count} channel(s)</p>
                    </button>
                  );
                })}
              </div>
            )}
          </ListPanel>
        }
      >
        {selected ? (
          <NvrDetail
            key={selected.id}
            nvr={selected}
            siteNames={siteNames}
            onMapChannels={(n) => setMapTarget(n)}
            onEdit={(n) => setEditTarget(n)}
            onDelete={askDelete}
          />
        ) : (
          <EmptyDetail icon="heroicons-outline:server-stack" title="Select an NVR" subtitle="Choose an NVR to view health and channel mapping." />
        )}
      </MasterDetail>

      {addOpen && <AddNvrModal onClose={() => setAddOpen(false)} onSuccess={() => { setAddOpen(false); qc.invalidateQueries({ queryKey: ["vms-nvrs"] }); }} />}
      {discoverOpen && <NvrDiscoveryModal onClose={() => setDiscoverOpen(false)} onSuccess={() => { setDiscoverOpen(false); qc.invalidateQueries({ queryKey: ["vms-nvrs"] }); }} />}
      {editTarget && <AddNvrModal nvr={editTarget} onClose={() => setEditTarget(null)} onSuccess={() => { setEditTarget(null); qc.invalidateQueries({ queryKey: ["vms-nvrs"] }); }} />}
      {mapTarget && (
        <ChannelMappingModal
          nvr={mapTarget}
          sites={sites}
          onClose={() => setMapTarget(null)}
          onSuccess={() => { setMapTarget(null); qc.invalidateQueries({ queryKey: ["nvr-cams", mapTarget.id] }); qc.invalidateQueries({ queryKey: ["vms-cameras"] }); }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
