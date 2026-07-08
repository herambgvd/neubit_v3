"use client";

// AlarmBoard — the default view. A responsive grid of AlarmCards (sorted most
// urgent first), a select-all / clear header, and the same pager the table had.
// Props-driven so IncidentList owns the data + selection + mutations.

import { Icon } from "@iconify/react";
import { Card, Spinner } from "@/components/ui/kit";

import AlarmCard from "./AlarmCard";
import { incId, sortForBoard } from "./lib";

export default function AlarmBoard({
  rows = [],
  loading,
  hasFilters,
  selected,
  onToggle,
  allSelected,
  onToggleAll,
  sopName = {},
  siteName = {},
  newIds,
  onAck,
  onAssign,
  actionPending,
  total = 0,
  page = 0,
  pageSize = 25,
  onPage,
}) {
  const sorted = sortForBoard(rows);
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, total || rows.length);
  const showPager = !loading && rows.length > 0;

  if (loading) {
    return (
      <Card className="flex justify-center py-16">
        <Spinner />
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card className="flex flex-col items-center justify-center py-20 text-center">
        <Icon icon="heroicons-outline:shield-check" className="mb-3 text-4xl text-muted opacity-60" />
        <p className="font-medium text-foreground">No active alarms</p>
        <p className="mt-1 text-sm text-muted">
          {hasFilters ? "Try clearing filters." : "Incidents will appear here as they are raised."}
        </p>
      </Card>
    );
  }

  return (
    <div>
      {/* Board toolbar */}
      <div className="mb-2.5 flex items-center gap-2 px-0.5 text-xs text-muted">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all" />
          Select all on page
        </label>
        <span className="ml-auto">{rows.length} shown</span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
        {sorted.map((it) => {
          const id = incId(it);
          return (
            <AlarmCard
              key={id}
              incident={it}
              sopName={sopName}
              siteName={siteName}
              isNew={newIds?.has?.(String(id))}
              selected={selected?.has?.(id)}
              onSelect={onToggle}
              onAck={onAck}
              onAssign={onAssign}
              actionPending={actionPending}
            />
          );
        })}
      </div>

      {showPager && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-card-border px-4 py-2.5 text-xs text-muted">
          <span>
            {showingFrom}–{showingTo} of {total || rows.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => onPage?.(Math.max(0, page - 1))}
              className="rounded-md border border-card-border px-2.5 py-1 hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Previous
            </button>
            <span>
              Page {page + 1} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page + 1 >= totalPages}
              onClick={() => onPage?.(page + 1)}
              className="rounded-md border border-card-border px-2.5 py-1 hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
