"use client";

// Access Control — master/detail. LEFT: onboarded controllers (search + Add + online
// counts). RIGHT: brand-specific InstanceDetail. Ported from neubit_v2's
// devices/access-control/page.jsx, rethemed to v3 tokens + the shared MasterDetail /
// ListPanel scaffold. Add flow: BrandPicker → brand Onboard modal → refetch.
//
// v3 note: v2's drag-reorder + bulk-delete were device-list extras (from
// components/devices/*) that aren't part of the shared v3 layer; this port keeps the
// core master/detail + per-row kebab (Edit/Delete) faithfully and omits those extras.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { sites as sitesApi } from "@/lib/api/sites";
import { gates } from "./api";
import InstanceListCard from "./components/InstanceListCard";
import InstanceDetail from "./components/InstanceDetail";
import BrandPickerModal from "./components/BrandPickerModal";
import OnboardInstanceModal from "./components/OnboardInstanceModal";
import EditInstanceModal from "./components/EditInstanceModal";

export default function AccessControlPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<any>(null);
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [activeBrand, setActiveBrand] = useState<any>(null);
  const [editTarget, setEditTarget] = useState<any>(null);
  const [confirm, setConfirm] = useState<any>(null);

  const instancesQ = useQuery<any>({
    queryKey: ["ac-instances"],
    queryFn: () => gates.instances.list(),
    refetchInterval: 15_000,
  });
  const instances = useMemo(() => asItems(instancesQ.data), [instancesQ.data]);

  const sitesQ = useQuery<any>({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 200 }),
    staleTime: 60_000,
  });
  const sites = asItems(sitesQ.data);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return instances;
    return instances.filter((i) => i.name?.toLowerCase().includes(term) || i.base_url?.toLowerCase().includes(term));
  }, [instances, search]);

  const selected = useMemo(() => instances.find((i) => i.id === selectedId) || null, [instances, selectedId]);

  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const onlineCount = instances.filter((i) => i.status === "online" || i.status === "active").length;

  const remove = useMutation<any>({
    mutationFn: (id: any) => gates.instances.remove(id),
    onSuccess: (_d, id) => {
      toast.success("Instance removed");
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["ac-instances"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title="Access Control"
            count={instances.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name or URL…"
            action={
              <div className="flex items-center gap-1">
                <button
                  onClick={() => qc.invalidateQueries({ queryKey: ["ac-instances"] })}
                  title="Refresh"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] border border-[rgba(150,180,245,.22)] text-[#aec2e8] transition hover:border-[#22d3ee] hover:text-[#22d3ee]"
                >
                  <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
                </button>
                <button
                  onClick={() => setBrandPickerOpen(true)}
                  title="Add controller"
                  className="inline-flex h-7 items-center gap-1 rounded-[8px] border border-[rgba(34,211,238,.5)] bg-[rgba(34,211,238,.15)] px-2.5 text-[12px] font-medium text-[#67e8f9] transition hover:border-[#22d3ee] hover:bg-[rgba(34,211,238,.25)]"
                >
                  <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
                </button>
              </div>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[1.2px]">
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#34d399] shadow-[0_0_5px_#34d399]" />
                <span className="text-[#aec2e8]">{onlineCount} online</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#f87171] shadow-[0_0_5px_rgba(248,113,113,.6)]" />
                <span className="text-[#7e93bf]">{instances.length - onlineCount} offline</span>
              </span>
            </div>

            {instancesQ.isLoading ? (
              <div className="px-4 py-6 text-center text-xs text-muted">
                <Icon icon="svg-spinners:180-ring" className="mx-auto mb-1 text-base" />
                Loading…
              </div>
            ) : instancesQ.isError ? (
              <div className="px-4 py-6 text-center text-xs text-red-500">{apiError(instancesQ.error, "Failed to load instances")}</div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted">
                {instances.length === 0 ? "No controllers yet - click Add to onboard one." : "No matches."}
              </div>
            ) : (
              <div className="space-y-1.5 px-3 py-2">
                {filtered.map((i) => (
                  <InstanceListCard
                    key={i.id}
                    instance={i}
                    siteName={sites.find((s) => s.site_id === i.site_id)?.name}
                    isSelected={selectedId === i.id}
                    onSelect={(d) => setSelectedId(d.id)}
                    onEdit={(d) => setEditTarget(d)}
                    onDelete={(d) =>
                      setConfirm({
                        title: "Delete Access Control Server",
                        message: `This will remove ${d.name}. This action cannot be undone.`,
                        confirmLabel: "Delete",
                        onConfirm: () => {
                          remove.mutate(d.id);
                          setConfirm(null);
                        },
                      })
                    }
                  />
                ))}
              </div>
            )}
          </ListPanel>
        }
      >
        {selected ? (
          <InstanceDetail key={selected.id} instanceId={selected.id} sites={sites} />
        ) : (
          <EmptyDetail icon="heroicons-outline:server" title="Select a controller" subtitle="Choose one from the list to view details." />
        )}
      </MasterDetail>

      {/* Onboard step 1 — brand picker */}
      {brandPickerOpen && (
        <BrandPickerModal
          onClose={() => setBrandPickerOpen(false)}
          onPick={(brandId) => {
            setBrandPickerOpen(false);
            setActiveBrand(brandId);
          }}
        />
      )}

      {/* Onboard step 2 — brand-specific form (DDS only today) */}
      {activeBrand === "dds" && (
        <OnboardInstanceModal
          onClose={() => setActiveBrand(null)}
          onSuccess={() => {
            setActiveBrand(null);
            qc.invalidateQueries({ queryKey: ["ac-instances"] });
          }}
        />
      )}

      {editTarget && (
        <EditInstanceModal instance={editTarget} onClose={() => setEditTarget(null)} onSuccess={() => setEditTarget(null)} />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
