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

export function MasterDetail({ aside, children, gridCols = "lg:grid-cols-[22rem_1fr]", className = "" }) {
  return (
    <div className={`grid min-h-[70vh] grid-cols-1 gap-4 ${gridCols} ${className}`}>
      {aside}
      {children}
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
      <header className="flex items-center justify-between border-b border-card-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</span>
          {count != null && (
            <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-muted">{count}</span>
          )}
        </div>
        {action}
      </header>

      {onSearch && (
        <div className="p-3">
          <label className="relative block">
            <Icon
              icon="heroicons-outline:magnifying-glass"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-base text-muted"
            />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-9 w-full rounded-lg border border-field bg-transparent pl-8 pr-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted"
            />
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
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
