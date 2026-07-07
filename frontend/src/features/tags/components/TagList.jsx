"use client";

// Left master list for the Tags page — search-filtered tag rows with a color
// swatch, name, description and usage badge. Presentational: the parent owns
// selection, mode and the filtered array. Wrapped by ListPanel in Tags.jsx.
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";
import { DEFAULT_COLOR } from "../constants";

export default function TagList({ items, loading, query, selectedId, mode, onSelect }) {
  if (loading) {
    return (
      <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
        <Spinner className="!h-4 !w-4" /> Loading…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
          <Icon icon="heroicons:tag" className="text-lg text-muted" />
        </div>
        <div className="text-sm font-medium text-foreground">
          {query.trim() ? "No tags match your search" : "No tags yet"}
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {query.trim() ? "Try a different keyword." : "Click Add tag to create your first tag."}
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-card-border">
      {items.map((t) => {
        const isSelected = t.tag_id === selectedId && mode !== "create";
        return (
          <li key={t.tag_id} className="relative">
            <button
              onClick={() => onSelect(t.tag_id)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left transition ${
                isSelected ? "bg-hover" : "hover:bg-hover"
              }`}
            >
              {isSelected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
              <span
                className="h-4 w-4 rounded-full border border-card-border shrink-0"
                style={{ background: t.color || DEFAULT_COLOR }}
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground truncate">{t.name}</span>
                  {t.is_active === false && (
                    <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium">Inactive</span>
                  )}
                </span>
                {t.description && <span className="block text-xs text-muted truncate">{t.description}</span>}
              </span>
              {typeof t.usage_count === "number" && t.usage_count > 0 && (
                <span className="text-[10px] rounded-full bg-hover text-muted px-1.5 py-0.5 font-medium shrink-0">
                  {t.usage_count}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
