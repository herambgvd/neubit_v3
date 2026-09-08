"use client";

// Left master rail of ingest categories — navy console (matches Sites/Users):
// header + count, search, selectable cards, and a dashed New Category button at
// the bottom. Purely presentational — the page owns state + data.
import { Icon } from "@iconify/react";
import type { ReactNode } from "react";

import type { CategoryPublic } from "../types";
import {
  ConsolePanel,
  PanelHeader,
  IconButton,
  PanelSearch,
  PanelList,
} from "@/components/console";

export interface CategoryListProps {
  /** Already filtered by the parent's search box. */
  categories: CategoryPublic[];
  /** Unfiltered count, shown in the header. */
  total: number;
  loading?: boolean;
  /** A load FAILURE. Distinct from `categories: []`, which means the estate is
   *  genuinely empty — reading one as the other is what gets an operator to
   *  re-create a category that already exists. */
  error?: ReactNode;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The parent's id accessor (handles id vs category_id). */
  catId: (c: CategoryPublic) => string | undefined;
  /** True while the create form is open, so no row reads as selected. */
  suppressSelected?: boolean;
  onNew: () => void;
}

export default function CategoryList({
  categories,
  total,
  loading,
  error,
  search,
  onSearch,
  selectedId,
  onSelect,
  catId,
  suppressSelected = false,
  onNew,
}: CategoryListProps) {
  return (
    <ConsolePanel>
      <PanelHeader icon="heroicons-outline:squares-2x2" title="Categories" count={total}
        actions={
          <IconButton icon="heroicons:plus" title="New category" onClick={onNew} />
        }
      />
      <PanelSearch value={search} onChange={onSearch} placeholder="Search categories…" />

      <PanelList
        loading={loading}
        error={error}
        empty={categories.length === 0}
        emptyText={search.trim() ? "No categories match your search" : "No categories yet"}
      >
        {categories.map((c) => {
              const isSelected = catId(c) === selectedId && !suppressSelected;
              return (
                <button
                  key={catId(c)}
                  onClick={() => onSelect(catId(c) ?? "")}
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

    </ConsolePanel>
  );
}
