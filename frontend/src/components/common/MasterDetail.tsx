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
export function MasterDetail({ aside, children, gridCols = "lg:grid-cols-[22rem_1fr]", className = "", fill = false }: any) {
  return (
    <div
      className={`grid grid-cols-1 gap-3 ${
        fill ? "h-full min-h-0" : "min-h-[70vh]"
      } ${gridCols} ${className}`}
    >
      {aside}
      {fill ? (
        <div className="scroll-themed flex min-h-0 flex-col overflow-y-auto">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

export function ListPanel({
  title,
  icon,
  count,
  action,
  search,
  onSearch,
  searchPlaceholder = "Search…",
  children,
  className = "",
}: any) {
  return (
    <aside className={`flex min-h-0 flex-col rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] ${className}`}>
      <header className="flex shrink-0 items-center justify-between border-b border-nb-line px-3 py-2">
        <div className="flex items-center gap-2">
          {icon && <Icon icon={icon} className="text-sm text-nb-muted" />}
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-nb-muted">{title}</span>
          {count != null && (
            <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-nb-muted">{count}</span>
          )}
        </div>
        {action}
      </header>

      {onSearch && (
        <div className="shrink-0 p-2">
          <label className="relative block">
            <Icon
              icon="heroicons-outline:magnifying-glass"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nb-faint"
            />
            <input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 w-full rounded-lg border border-nb-line bg-nb-field pl-8 pr-3 text-[13px] text-nb-ink placeholder:text-nb-faint outline-hidden transition focus:border-nb-teal focus:ring-1 focus:ring-nb-teal/40"
            />
          </label>
        </div>
      )}

      <div className="scroll-themed min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

// Right-hand empty placeholder for when nothing is selected.
export function EmptyDetail({ icon = "heroicons-outline:cursor-arrow-rays", title = "Nothing selected", subtitle }: any) {
  return (
    <section className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl border border-nb-line bg-[rgba(8,15,34,.5)] py-20 text-center">
      <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-nb-teal/10 text-nb-teal">
        <Icon icon={icon} className="text-xl" />
      </span>
      <div className="mt-3 text-sm font-semibold text-nb-ink">{title}</div>
      {subtitle && <div className="mt-0.5 text-xs text-nb-muted">{subtitle}</div>}
    </section>
  );
}

export default MasterDetail;
