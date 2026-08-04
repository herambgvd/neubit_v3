"use client";

// Sites configuration — page-entry orchestrator. Two-pane master/detail: the left
// ListPanel (search + status counts + rows) and the right SiteDetail (info/floors/
// zones tabs). Site create/edit lives in SiteFormModal; the floor-plan editor opens
// full-screen from the Floors tab. Ported from neubit_v2, rethemed to neubit_v3's
// Vercel tokens + kit/common components.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
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

  const col = "rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] min-h-0 flex flex-col overflow-hidden";

  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[300px_1fr]">
        {/* LEFT — library */}
        <div className={col}>
          <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
            <div className="flex items-center gap-2">
              <Icon icon="heroicons-outline:map-pin" className="text-sm text-nb-blueb" />
              <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Sites</span>
              <span className="font-mono text-[11px] text-nb-faint">{total}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" /><span className="text-nb-soft">{active}</span></span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-nb-faint" /><span className="text-nb-soft">{inactive}</span></span>
            </div>
          </div>
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
              <Icon icon="heroicons-outline:magnifying-glass" className="text-sm text-nb-faint" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or city…"
                className="w-full bg-transparent text-[12.5px] text-nb-muted outline-none placeholder:text-nb-faint"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {sitesQ.isLoading ? (
              <div className="flex items-center gap-2 px-1 py-6 text-sm text-nb-soft"><Spinner className="!h-4 !w-4" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-1 py-10 text-center text-xs text-nb-faint">
                {q.trim() ? "No sites match your search" : "No sites yet"}
              </div>
            ) : (
              <div className="space-y-2 pb-2">
                {filtered.map((s) => (
                  <SiteListItem
                    key={s.site_id}
                    site={s}
                    selected={s.site_id === selectedId && mode !== "create"}
                    onSelect={() => { setSelectedId(s.site_id); setMode("view"); setClosed(false); }}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-nb-line/50 p-3">
            <button
              onClick={() => setMode("create")}
              className="w-full rounded-[9px] border border-dashed border-[rgba(150,180,245,.42)] py-2.5 text-[12px] tracking-[.7px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
            >
              ＋ NEW SITE
            </button>
          </div>
        </div>

        {/* CENTER — detail */}
        <div className={col}>
          {!selected ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
                <Icon icon="heroicons-outline:map-pin" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-nb-ink">No site selected</div>
              <div className="text-xs text-nb-faint mt-0.5">
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
        </div>
      </div>

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
