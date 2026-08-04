"use client";

// Left master rail of ingest categories — navy console (matches Sites/Users):
// header + count, search, selectable cards, and a dashed New Category button at
// the bottom. Purely presentational — the page owns state + data.
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";

export default function CategoryList({
  className = "",
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
}) {
  return (
    <div className={className}>
      <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
        <Icon icon="heroicons-outline:squares-2x2" className="text-sm text-nb-blueb" />
        <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Categories</span>
        <span className="font-mono text-[11px] text-nb-faint">{total}</span>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
          <Icon icon="heroicons-outline:magnifying-glass" className="text-sm text-nb-faint" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search categories…"
            className="w-full bg-transparent text-[12.5px] text-nb-muted outline-none placeholder:text-nb-faint"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3">
        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-nb-soft">
            <Spinner className="!h-4 !w-4" /> Loading…
          </div>
        ) : categories.length === 0 ? (
          <div className="px-1 py-10 text-center text-xs text-nb-faint">
            {search.trim() ? "No categories match your search" : "No categories yet"}
          </div>
        ) : (
          <div className="space-y-2 pb-2">
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
          </div>
        )}
      </div>

      <div className="border-t border-nb-line/50 p-3">
        <button
          onClick={onNew}
          className="w-full rounded-[9px] border border-dashed border-[rgba(150,180,245,.42)] py-2.5 text-[12px] tracking-[.7px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          ＋ NEW CATEGORY
        </button>
      </div>
    </div>
  );
}
