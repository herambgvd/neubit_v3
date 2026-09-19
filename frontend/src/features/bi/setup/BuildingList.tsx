"use client";

// The building picker every per-building Setup page opens with.
//
// It lists Building Intelligence's own copy of Configurations → Sites
// (`GET /bi/rating/sites`, the `site_facts` mirror) — read under `bi.read`, like
// every other BI surface. Sites stays the one list of buildings; BI reads it and
// writes nothing there.
import { useMemo, useState, type ReactNode } from "react";

import { ConsolePanel, PanelHeader, PanelList, PanelSearch } from "@/components/console";
import { apiError } from "@/lib/api";
import type { BiSiteFactsRow } from "@/lib/types";

import { useBuildings } from "./useBuildings";

export interface BuildingListProps {
  selectedId: string | null;
  onSelect: (siteId: string) => void;
  /** One line of state under a building's name. */
  meta?: (row: BiSiteFactsRow) => ReactNode;
  icon?: string;
}

export default function BuildingList({ selectedId, onSelect, meta, icon = "heroicons-outline:building-office-2" }: Readonly<BuildingListProps>) {
  const { q, items } = useBuildings();
  const [search, setSearch] = useState("");
  const shown = useMemo(() => {
    const n = search.trim().toLowerCase();
    return n ? items.filter((s) => (s.site_name || s.site_id).toLowerCase().includes(n)) : items;
  }, [items, search]);

  return (
    <ConsolePanel>
      <PanelHeader icon={icon} title="Buildings" count={q.data ? items.length : "—"} />
      {items.length > 6 && <PanelSearch value={search} onChange={setSearch} placeholder="Search buildings…" />}
      <PanelList
        loading={q.isLoading}
        error={q.error ? apiError(q.error, "Could not load the buildings") : null}
        empty={!shown.length}
        emptyText={search.trim() ? "No building matches" : "No building in Configurations → Sites yet"}
      >
        {shown.map((s) => {
          const on = s.site_id === selectedId;
          return (
            <button
              key={s.site_id}
              type="button"
              aria-pressed={on}
              onClick={() => onSelect(s.site_id)}
              className={`w-full rounded-[10px] border px-3 py-2 text-left transition ${
                on
                  ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.12)]"
                  : "border-nb-line bg-[rgba(6,11,26,.45)] hover:bg-white/5"
              }`}
            >
              <div className="truncate text-[12.5px] text-nb-ink">{s.site_name || s.site_id}</div>
              {meta && <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px]">{meta(s)}</div>}
            </button>
          );
        })}
      </PanelList>
    </ConsolePanel>
  );
}
