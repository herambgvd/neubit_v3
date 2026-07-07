"use client";

// Left master list of ingest categories. Search + selectable rows, wrapped in the
// shared <ListPanel>. Purely presentational — the page owns state + data.
import { Icon } from "@iconify/react";

import { ListPanel } from "@/components/common";
import { Spinner } from "@/components/ui/kit";

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
}) {
  return (
    <ListPanel
      title="Categories"
      count={total}
      search={search}
      onSearch={onSearch}
      searchPlaceholder="Search categories…"
    >
      {loading ? (
        <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
          <Spinner className="!h-4 !w-4" /> Loading…
        </div>
      ) : categories.length === 0 ? (
        <div className="px-4 py-12 text-center">
          <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
            <Icon icon="heroicons-outline:squares-2x2" className="text-lg text-muted" />
          </div>
          <div className="text-sm font-medium text-foreground">
            {search.trim() ? "No categories match" : "No categories yet"}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {search.trim() ? "Try a different keyword." : "Add a category to group webhooks."}
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-card-border">
          {categories.map((c) => {
            const isSelected = catId(c) === selectedId && !suppressSelected;
            return (
              <li key={catId(c)} className="relative">
                <button
                  onClick={() => onSelect(catId(c))}
                  className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
                    isSelected ? "bg-hover" : "hover:bg-hover"
                  }`}
                >
                  {isSelected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-blue-500/10 text-blue-500 shrink-0 border border-card-border">
                    <Icon icon="heroicons-outline:squares-2x2" className="text-base" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground truncate">{c.name}</span>
                    {c.description && (
                      <span className="block text-xs text-muted truncate">{c.description}</span>
                    )}
                    {typeof c.webhook_count === "number" && (
                      <span className="block text-[10px] text-muted/70">{c.webhook_count} webhook(s)</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </ListPanel>
  );
}
