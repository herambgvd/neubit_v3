"use client";

// Sites configuration — page-entry orchestrator. Two-pane master/detail: the left
// ListPanel (search + status counts + rows) and the right SiteDetail (info/floors/
// zones tabs). Site create/edit lives in SiteFormModal; the floor-plan editor opens
// full-screen from the Floors tab. Ported from neubit_v2, rethemed to neubit_v3's
// Vercel tokens + kit/common components.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel, EmptyDetail } from "@/components/common";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import SiteListItem from "./components/SiteListItem";
import SiteDetail from "./components/SiteDetail";
import SiteFormModal from "./components/SiteFormModal";

export default function SitesConfigPage() {
  const qc = useQueryClient();
  const sitesQ = useQuery({
    queryKey: ["sites-list"],
    queryFn: () => sitesApi.list({ limit: 100 }),
  });

  const items = sitesQ.data?.items || [];
  const total = sitesQ.data?.total ?? items.length;
  const active = items.filter((s) => s.is_active !== false).length;
  const inactive = items.length - active;

  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("view"); // view | create | edit
  const [closed, setClosed] = useState(false);
  const [tab, setTab] = useState("info"); // info | floors | zones
  const [confirm, setConfirm] = useState(null);

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

  const remove = useMutation({
    mutationFn: (id) => sitesApi.remove(id),
    onSuccess: () => {
      toast.success("Site removed");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
      setSelectedId(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const setThreatLevel = useMutation({
    mutationFn: ({ id, level }) => sitesApi.setThreatLevel(id, level),
    onSuccess: () => {
      toast.success("Threat level updated");
      qc.invalidateQueries({ queryKey: ["sites-list"] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const listActions = (
    <div className="flex items-center gap-1">
      <Link
        href="/map"
        title="Map view"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-card-border px-2 text-[12px] font-medium text-foreground transition hover:bg-hover"
      >
        <Icon icon="heroicons-outline:map" className="text-sm" /> Map
      </Link>
      <button
        onClick={() => setMode("create")}
        title="Add site"
        className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
      >
        <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MasterDetail
        fill
        className="min-h-0 flex-1"
        aside={
          <ListPanel
            title="Sites"
            count={total}
            action={listActions}
            search={q}
            onSearch={setQ}
            searchPlaceholder="Search by name or city…"
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span className="text-muted">{active} active</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                <span className="text-muted">{inactive} inactive</span>
              </span>
            </div>

            {sitesQ.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:map-pin" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {q.trim() ? "No sites match your search" : "No sites yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {q.trim() ? "Try a different keyword." : "Click Add site to create your first site."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((s) => (
                  <SiteListItem
                    key={s.site_id}
                    site={s}
                    selected={s.site_id === selectedId && mode !== "create"}
                    onSelect={() => {
                      setSelectedId(s.site_id);
                      setMode("view");
                      setClosed(false);
                    }}
                  />
                ))}
              </ul>
            )}
          </ListPanel>
        }
      >
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-full flex flex-col">
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:map-pin" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No site selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add site</b> to create a new site.
              </div>
            </div>
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
        </section>
      </MasterDetail>

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
    </div>
  );
}
