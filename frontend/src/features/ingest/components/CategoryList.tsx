"use client";

// Left master rail of ingest categories — navy console (matches Sites/Users):
// header + count, search, selectable cards, and a dashed New Category button at
// the bottom. Purely presentational — the page owns state + data.
import { Icon } from "@iconify/react";

import {
  ConsolePanel,
  PanelHeader,
  PanelSearch,
  PanelList,
  PanelFooter,
  CreateButton,
} from "@/components/console";

export default function CategoryList({
  categories,
  total,
  loading,
  search,
  onSearch,
  selectedId,
  onSelect,
  catId,
  suppressSelected = false,
  onNew,
}: any) {
  return (
    <ConsolePanel>
      <PanelHeader icon="heroicons-outline:squares-2x2" title="Categories" count={total} />
      <PanelSearch value={search} onChange={onSearch} placeholder="Search categories…" />

      <PanelList
        loading={loading}
        empty={categories.length === 0}
        emptyText={search.trim() ? "No categories match your search" : "No categories yet"}
      >
        {categories.map((c) => {
              const isSelected = catId(c) === selectedId && !suppressSelected;
              return (
                <button
                  key={catId(c)}
                  onClick={() => onSelect(catId(c))}
                  className={`flex w-full items-start gap-3 rounded-[10px] border px-3 py-2.5 text-left transition ${
                    isSelected
                      ? "border-[rgba(96,165,250,.6)] bg-[rgba(96,165,250,.1)]"
                      : "border-nb-line bg-[rgba(6,11,26,.5)] hover:border-[rgba(150,180,245,.42)]"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-[8px] border ${
                      isSelected
                        ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.12)] text-nb-blueb"
                        : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted"
                    }`}
                  >
                    <Icon icon="heroicons-outline:squares-2x2" className="text-base" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[13px] font-semibold ${isSelected ? "text-nb-ink" : "text-nb-soft"}`}>
                      {c.name}
                    </span>
                    {c.description && (
                      <span className="block truncate text-[11.5px] text-nb-faint">{c.description}</span>
                    )}
                    {typeof c.webhook_count === "number" && (
                      <span className="mt-0.5 block font-mono text-[10px] text-nb-faint">
                        {c.webhook_count} webhook{c.webhook_count === 1 ? "" : "s"}
                      </span>
                    )}
                  </span>
                </button>
              );
        })}
      </PanelList>

      <PanelFooter>
        <CreateButton label="CATEGORY" onClick={onNew} />
      </PanelFooter>
    </ConsolePanel>
  );
}
