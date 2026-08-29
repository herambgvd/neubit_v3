"use client";

// AlarmBoard — the default view. A responsive grid of AlarmCards (sorted most
// urgent first), a select-all / clear header, and the same pager the table had.
// Props-driven so IncidentList owns the data + selection + mutations.

import { Icon } from "@iconify/react";

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
      <div className="flex justify-center rounded-[13px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] py-16 backdrop-blur-xs">
        <Icon icon="svg-spinners:180-ring" className="text-2xl text-[#67e8f9]" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[13px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] py-20 text-center backdrop-blur-xs">
        <Icon icon="heroicons-outline:shield-check" className="mb-3 text-4xl text-[#67e8f9] opacity-70" />
        <p className="font-medium text-[#f2f6ff]">No active alarms</p>
        <p className="mt-1 text-sm text-[#7e93bf]">
          {hasFilters ? "Try clearing filters." : "Incidents will appear here as they are raised."}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Board toolbar */}
      <div className="mb-2.5 flex items-center gap-2 px-0.5 font-mono text-[11px] uppercase tracking-[1px] text-[#7e93bf]">
        <label className="inline-flex items-center gap-2 cursor-pointer hover:text-[#aec2e8]">
          <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all" className="accent-[#22d3ee]" />
          Select all on page
        </label>
        <span className="ml-auto"><b className="text-[#f2f6ff]">{rows.length}</b> shown</span>
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
        <div className="mt-3 flex items-center justify-between rounded-[13px] border border-[rgba(150,180,245,.22)] bg-[rgba(150,180,245,.04)] px-4 py-2.5 font-mono text-[11px] text-[#aec2e8] backdrop-blur-xs">
          <span>
            {showingFrom}–{showingTo} of {total || rows.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => onPage?.(Math.max(0, page - 1))}
              className="rounded-[8px] border border-[rgba(150,180,245,.22)] px-2.5 py-1 transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9] disabled:opacity-40 disabled:hover:border-[rgba(150,180,245,.22)] disabled:hover:text-[#aec2e8]"
            >
              Previous
            </button>
            <span className="text-[#7e93bf]">
              Page {page + 1} of {totalPages}
            </span>
            <button
              type="button"
              disabled={page + 1 >= totalPages}
              onClick={() => onPage?.(page + 1)}
              className="rounded-[8px] border border-[rgba(150,180,245,.22)] px-2.5 py-1 transition hover:border-[rgba(34,211,238,.5)] hover:text-[#67e8f9] disabled:opacity-40 disabled:hover:border-[rgba(150,180,245,.22)] disabled:hover:text-[#aec2e8]"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
