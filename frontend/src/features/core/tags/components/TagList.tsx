"use client";

// Left master list for the Tags page — search-filtered tag rows rendered by
// TagListItem. Presentational: the parent owns selection, mode and the filtered
// array. Wrapped by ListPanel in Tags.jsx.
import { Icon } from "@iconify/react";

import { Spinner } from "@/components/ui/kit";
import type { TagPublic } from "@/lib/types";
import TagListItem from "./TagListItem";

export interface TagListProps {
  items: TagPublic[];
  loading: boolean;
  /** A load failure; shown instead of the "no tags yet" empty state. */
  error?: string | null;
  query: string;
  selectedId: string | null;
  /** The page mode; "create" un-highlights the list. */
  mode: string;
  onSelect: (id: string) => void;
}

export default function TagList({ items, loading, error, query, selectedId, mode, onSelect }: TagListProps) {
  if (loading) {
    return (
      <div className="px-4 py-8 flex items-center gap-2 text-sm text-nb-muted">
        <Spinner className="!h-4 !w-4" /> Loading…
      </div>
    );
  }

  // A failed load must never read as "no tags yet" — that is the same screen an
  // empty library shows, and it invites the operator to create a duplicate.
  if (error) {
    return <div className="px-4 py-12 text-center text-sm text-nb-crit">{error}</div>;
  }

  if (items.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/5">
          <Icon icon="heroicons:tag" className="text-lg text-nb-muted" />
        </div>
        <div className="text-sm font-medium text-nb-ink">
          {query.trim() ? "No tags match your search" : "No tags yet"}
        </div>
        <div className="mt-0.5 text-xs text-nb-muted">
          {query.trim() ? "Try a different keyword." : "Click Add tag to create your first tag."}
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-nb-line">
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
