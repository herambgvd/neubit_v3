"use client";

// Sites configuration — page-entry orchestrator. Two-pane master/detail: the left
// list panel (search + status counts + rows) and the right SiteDetail (info/floors/
// zones tabs). Site create/edit lives in SiteFormModal; the floor-plan editor opens
// full-screen from the Floors tab. Ported from neubit_v2; the console frame comes
// from components/console so it stays identical to Users & Roles / Federation.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelCounts,
  PanelSearch,
  PanelList,
  PanelFooter,
  CreateButton,
  EmptyPane,
} from "@/components/console";
import { ConfirmDialog } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import SiteListItem from "./components/SiteListItem";
import SiteDetail from "./components/SiteDetail";
import SiteFormModal from "./components/SiteFormModal";

export default function SitesConfigPage() {
  const qc = useQueryClient();
  const sitesQ = useQuery<any>({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const items = sitesQ.data?.items || [];
  const total = sitesQ.data?.total ?? items.length;
  const active = items.filter((s) => s.is_active !== false).length;
  const inactive = items.length - active;

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<any>(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState("info"); // info | floors | zones
  const [confirm, setConfirm] = useState<any>(null);

  const filtered = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return items;
    return items.filter((s) => {
      const hay = [s.name, s.location_code, s.address?.city, s.address?.state, s.address?.country]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(f);
    });
  }, [items, q]);

  const selected = useMemo(
    () => items.find((s) => s.site_id === selectedId) || null,
    [items, selectedId],
  );

  useEffect(() => {
    if (mode === "view" && !closed && !selected && filtered[0]) {
      setSelectedId(filtered[0].site_id);
    }
  }, [filtered, selected, mode, closed]);

  useEffect(() => {
    setTab("info");
  }, [selectedId]);

  const remove = useMutation<any>({
    mutationFn: (id: any) => sitesApi.remove(id),
    onSuccess: () => {
      toast.success("Site removed");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const setThreatLevel = useMutation<any, any, any>({
    mutationFn: ({ id, level }: any) => sitesApi.setThreatLevel(id, level),
    onSuccess: () => {
      toast.success("Threat level updated");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <ConsolePage>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr]">
        {/* LEFT — library */}
        <ConsolePanel>
          <PanelHeader
            icon="heroicons-outline:map-pin"
            title="Sites"
            count={total}
            actions={
              <PanelCounts
                items={[
                  { tone: "good", value: active, label: "active" },
                  { tone: "idle", value: inactive, label: "inactive" },
                ]}
              />
            }
          />
          <PanelSearch value={q} onChange={setQ} placeholder="Search by name or city…" />

          <PanelList
            loading={sitesQ.isLoading}
            empty={filtered.length === 0}
            emptyText={q.trim() ? "No sites match your search" : "No sites yet"}
          >
            {filtered.map((s) => (
              <SiteListItem
                key={s.site_id}
                site={s}
                selected={s.site_id === selectedId && mode !== "create"}
                onSelect={() => { setSelectedId(s.site_id); setMode("view"); setClosed(false); }}
              />
            ))}
          </PanelList>

          <PanelFooter>
            <CreateButton label="SITE" onClick={() => setMode("create")} />
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              A site is a <b className="text-nb-blueb">physical location</b> — its floors, zones and
              cameras hang off it, and user access is scoped by it.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* CENTER — detail */}
        <ConsolePanel>
          {!selected ? (
            <EmptyPane
              icon="heroicons-outline:map-pin"
              title="No site selected"
              subtitle="Pick one from the list, or click ＋ NEW SITE to create a site."
            />
          ) : (
            <SiteDetail
              site={selected}
              tab={tab}
              onTabChange={setTab}
              onClose={() => {
                setSelectedId(null);
                setClosed(true);
              }}
              onEdit={() => setMode("edit")}
              onDelete={() =>
                setConfirm({
                  title: "Delete site?",
                  message: `Delete site "${selected.name}" and all of its floors and zones? This cannot be undone.`,
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    remove.mutate(selected.site_id);
                    setConfirm(null);
                  },
                })
              }
              onChangeThreat={(level) => setThreatLevel.mutate({ id: selected.site_id, level })}
            />
          )}
        </ConsolePanel>
      </ConsoleGrid>

      {(mode === "create" || mode === "edit") && (
        <SiteFormModal
          key={mode === "edit" ? selected?.site_id : "create"}
          site={mode === "edit" ? selected : null}
          allSites={items}
          onCancel={() => setMode("view")}
          onSaved={(saved) => {
            qc.invalidateQueries({ queryKey: ["sites-list"] });
            if (saved?.site_id) setSelectedId(saved.site_id);
            setMode("view");
          }}
        />
      )}

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </ConsolePage>
  );
}
