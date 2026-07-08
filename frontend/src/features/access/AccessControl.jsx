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

import { Button, ConfirmDialog, PageHeader } from "@/components/ui/kit";
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
  const [selectedId, setSelectedId] = useState(null);
  const [brandPickerOpen, setBrandPickerOpen] = useState(false);
  const [activeBrand, setActiveBrand] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const instancesQ = useQuery({
    queryKey: ["ac-instances"],
    queryFn: () => gates.instances.list(),
    refetchInterval: 15_000,
  });
  const instances = useMemo(() => asItems(instancesQ.data), [instancesQ.data]);

  const sitesQ = useQuery({
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

  const remove = useMutation({
    mutationFn: (id) => gates.instances.remove(id),
    onSuccess: (_d, id) => {
      toast.success("Instance removed");
      if (selectedId === id) setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["ac-instances"] });
    },
    onError: (e) => toast.error(apiError(e, "Delete failed")),
  });

  return (
    <div>
      <PageHeader
        title="Access Control"
        subtitle="Onboard and manage access-control controllers (DDS today; pluggable per brand)."
        actions={
          <Button variant="success" icon="heroicons-outline:plus" onClick={() => setBrandPickerOpen(true)}>
            Add controller
          </Button>
        }
      />

      <MasterDetail
        gridCols="lg:grid-cols-[24rem_1fr]"
        aside={
          <ListPanel
            title="Access Control"
            count={instances.length}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name or URL…"
            action={
              <button
                onClick={() => qc.invalidateQueries({ queryKey: ["ac-instances"] })}
                title="Refresh"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:arrow-path" className="text-sm" />
              </button>
            }
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-muted">{onlineCount} online</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                <span className="text-muted">{instances.length - onlineCount} offline</span>
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
