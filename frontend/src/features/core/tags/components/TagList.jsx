"use client";

// Left master list for the Tags page — search-filtered tag rows rendered by
// TagListItem. Presentational: the parent owns selection, mode and the filtered
// array. Wrapped by ListPanel in Tags.jsx.
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";
import TagListItem from "./TagListItem";

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
      {items.map((t) => (
        <TagListItem
          key={t.tag_id}
          tag={t}
          selected={t.tag_id === selectedId && mode !== "create"}
          onSelect={() => onSelect(t.tag_id)}
        />
      ))}
    </ul>
  );
}
