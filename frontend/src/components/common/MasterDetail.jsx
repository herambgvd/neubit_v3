"use client";

// Two-pane master/detail scaffold — the list-aside + detail-section layout that
// Sites, Tags, Ingest and WorkflowConfig each re-implemented. `MasterDetail` is
// the responsive grid; `ListPanel` is the left card (header + optional search +
// scroll body). Both are presentational — callers supply the rows and detail.
//
//   <MasterDetail aside={<ListPanel title="Sites" count={n} action={<Button/>}
//                          search={q} onSearch={setQ}>{rows}</ListPanel>}>
//     {selected ? <Detail/> : <EmptyDetail/>}
//   </MasterDetail>
//
// NOTE: pass `gridCols` as a STATIC class string (Tailwind JIT can't read a
// runtime-built arbitrary value). Defaults to a 22rem list column.
import { Icon } from "@iconify/react";

// `fill` = fill the parent's height and scroll INTERNALLY (no page scroll): the grid
// takes h-full, the list-aside scrolls its own body, and the detail pane gets its own
// themed scroll container. Used by the contained device pages (NVR / Access Control).
export function MasterDetail({ aside, children, gridCols = "lg:grid-cols-[22rem_1fr]", className = "", fill = false }) {
  return (
    <div
      className={`grid grid-cols-1 gap-3 ${
        fill ? "h-full min-h-0" : "min-h-[70vh]"
      } ${gridCols} ${className}`}
    >
      {aside}
      {fill ? (
        <div className="scroll-themed min-h-0 overflow-y-auto">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

export function ListPanel({
  title,
  count,
  action,
  search,
  onSearch,
  searchPlaceholder = "Search…",
  children,
  className = "",
}) {
  return (
    <aside className={`flex min-h-0 flex-col rounded-xl border border-card-border bg-card ${className}`}>
      <header className="flex shrink-0 items-center justify-between border-b border-card-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">{title}</span>
          {count != null && (
            <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] font-medium text-muted">{count}</span>
          )}
        </div>
        {action}
      </header>

      {onSearch && (
        <div className="shrink-0 p-2">
          <label className="relative block">
            <Icon
              icon="heroicons-outline:magnifying-glass"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted"
            />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted outline-none transition focus:border-muted"
            />
          </label>
        </div>
      )}

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

// Right-hand empty placeholder for when nothing is selected.
export function EmptyDetail({ icon = "heroicons-outline:cursor-arrow-rays", title = "Nothing selected", subtitle }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl border border-card-border bg-card py-20 text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
        <Icon icon={icon} className="text-xl" />
      </span>
      <div className="mt-3 text-sm font-semibold text-foreground">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
    </section>
  );
}

export default MasterDetail;
