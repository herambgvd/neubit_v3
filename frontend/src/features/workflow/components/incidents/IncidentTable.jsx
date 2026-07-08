"use client";

// Incident data table — checkbox column (per-row + select-all), title/id link,
// SOP, state, status/priority badges, site, assignee, updated-at. Handles its own
// loading + empty states. Props-driven so it can be reused with any incident-shaped
// rows: pass `rows`, the selection Set + togglers, and the name-lookup maps.
import Link from "next/link";
import { Icon } from "@iconify/react";
import { Badge, Card, Spinner } from "@/components/ui/kit";
import { titleize, fmtRelative } from "@/lib/format";
import { STATUS_COLOR, PRIORITY_COLOR } from "../../constants";

const rowId = (it) => it.id ?? it.instance_id;

export default function IncidentTable({
  rows = [],
  loading,
  hasFilters,
  selected,
  onToggle,
  allSelected,
  onToggleAll,
  sopName = {},
  siteName = {},
  total = 0,
  page = 0,
  pageSize = 25,
  onPage,
}) {
  const totalPages = Math.max(1, Math.ceil((total || 0) / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, total || rows.length);
  const showPager = !loading && rows.length > 0;

  return (
    <Card className="overflow-hidden">
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Icon icon="heroicons-outline:inbox" className="text-4xl text-muted mb-3 opacity-60" />
          <p className="text-foreground font-medium">No incidents</p>
          <p className="text-muted text-sm mt-1">
            {hasFilters ? "Try clearing filters." : "Incidents will appear here as they are raised."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted border-b border-card-border">
                <th className="w-10 px-4 py-3"><input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all" /></th>
                <th className="font-medium px-4 py-3">Incident</th>
                <th className="font-medium px-4 py-3">SOP</th>
                <th className="font-medium px-4 py-3">State</th>
                <th className="font-medium px-4 py-3">Status</th>
                <th className="font-medium px-4 py-3">Priority</th>
                <th className="font-medium px-4 py-3">Site</th>
                <th className="font-medium px-4 py-3">Assignee</th>
                <th className="font-medium px-4 py-3">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const id = rowId(it);
                const sid = it.sop_id ?? it.sop?.id;
                const siteRef = it.site_id ?? it.site?.site_id;
                return (
                  <tr key={id} className="border-b border-card-border hover:bg-hover transition">
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(id)} onChange={() => onToggle(id)} aria-label="Select incident" />
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/events/${id}`} className="flex flex-col">
                        <span className="font-medium text-foreground">{it.title || it.reference || `Incident ${String(id).slice(0, 8)}`}</span>
                        <span className="text-xs text-muted font-mono">{String(id).slice(0, 8)}</span>
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted">{it.sop_name || sopName[sid] || "—"}</td>
                    <td className="px-4 py-3">
                      <span className="text-foreground">{titleize(it.current_state || it.state)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge color={STATUS_COLOR[it.status] || "neutral"}>{titleize(it.status)}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge color={PRIORITY_COLOR[it.priority] || "neutral"}>{titleize(it.priority)}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted">{it.site_name || siteName[siteRef] || "—"}</td>
                    <td className="px-4 py-3 text-muted">
                      {it.assignee_name || it.assignee?.full_name || it.assignee?.email || "Unassigned"}
                    </td>
                    <td className="px-4 py-3 text-muted">{fmtRelative(it.updated_at || it.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showPager && (
        <div className="flex items-center justify-between border-t border-card-border px-4 py-2.5 text-xs text-muted">
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
    </Card>
  );
}
