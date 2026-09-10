"use client";

// THE ALARM TABLE — one table, dense, scannable, selectable, paged.
//
// It was a board of rich cards, two to a row. A card repeats every label on
// every row, so eight alarms filled a screen a table holds thirty of, and the eye
// had no column to run down: "everything breaching SLA" was a hunt rather than a
// glance. The same argument that moved the events feed to a table, and the same
// columns an operator triages by — how long, how bad, what, where, who has it.
//
// It also had a real defect the cards made easy to write: the whole card was a
// link, and the camera strip inside it held another one. An <a> inside an <a> is
// invalid HTML, and React said so on every render of the page.
//
// The row is the SELECTOR for the evidence above it. A click selects; it does not
// navigate. The full incident is one deliberate step away (the Details panel's
// "Open" link), because a click that leaves the page loses the video an operator
// was told to look at.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import { fmtRelative } from "@/lib/format";
import type { InstancePublic, NameMap } from "../../types";
import { incAssigneeName, incId, incSiteName, incSopName, incTitle, isOpen, sev, slaFor } from "./lib";

export interface AlarmTableProps {
  rows: InstancePublic[];
  selectedId?: string | null;
  onSelect?: (incident: InstancePublic) => void;
  checked: Set<string>;
  onToggleChecked: (id: string) => void;
  onToggleAll: () => void;
  sopName?: NameMap;
  siteName?: NameMap;
  /** Ids that arrived in the last few minutes — worth a mark, not a colour scheme. */
  newIds?: Set<string>;
  /** Filters live IN the table, with the rows they narrow. */
  toolbar?: ReactNode;
  /** Paging, at the right of the toolbar: the page does not scroll, so a footer
   *  under a full table is the one control an operator must reach past rows for. */
  paging?: ReactNode;
  /** Shown INSTEAD of rows when there are none — inside the table, so the filters
   *  stay on screen. A filter row that disappears the moment it empties the list
   *  takes away the one control that could widen it again. */
  empty?: ReactNode;
}

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-500",
  active: "bg-blue-500/10 text-blue-400",
  paused: "bg-slate-500/10 text-muted",
  resolved: "bg-emerald-500/10 text-emerald-400",
  completed: "bg-emerald-500/10 text-emerald-400",
  cancelled: "bg-slate-500/10 text-muted",
};

const SLA_TONE: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  breach: "text-red-400",
  done: "text-muted",
};

export default function AlarmTable({
  rows,
  selectedId = null,
  onSelect,
  checked,
  onToggleChecked,
  onToggleAll,
  sopName = {},
  siteName = {},
  newIds,
  toolbar,
  paging,
  empty,
}: AlarmTableProps) {
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(incId(r)));

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {(toolbar || paging) && (
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-card-border px-3 py-2">
          {toolbar}
          {paging && <span className="ml-auto flex items-center gap-2">{paging}</span>}
        </header>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && empty ? (
          <div className="grid h-full place-items-center">{empty}</div>
        ) : (
        <table className="w-full min-w-[52rem] text-left">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-card-border text-[10px] uppercase tracking-wide text-muted">
              <th className="w-8 px-2 py-1.5">
                <input
                  type="checkbox"
                  aria-label={allChecked ? "Clear selection" : "Select all on this page"}
                  checked={allChecked}
                  onChange={onToggleAll}
                  className="h-3.5 w-3.5 accent-blue-500"
                />
              </th>
              <th className="px-2 py-1.5 font-medium">Raised</th>
              <th className="px-2 py-1.5 font-medium">Deadline</th>
              <th className="px-2 py-1.5 font-medium">Alarm</th>
              <th className="px-2 py-1.5 font-medium">Priority</th>
              <th className="px-2 py-1.5 font-medium">Where</th>
              <th className="px-2 py-1.5 font-medium">State</th>
              <th className="px-2 py-1.5 font-medium">Owner</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-card-border/60">
            {rows.map((it) => {
              const id = incId(it);
              const s = sev(it.priority);
              const sla = slaFor(it);
              const isSelected = selectedId === id;
              const owner = incAssigneeName(it);
              return (
                <tr
                  key={id}
                  onClick={() => onSelect?.(it)}
                  aria-selected={isSelected}
                  className={`cursor-pointer text-[12px] transition ${
                    isSelected ? "bg-blue-500/10" : "hover:bg-hover/60"
                  }`}
                >
                  <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${incTitle(it)}`}
                      checked={checked.has(id)}
                      onChange={() => onToggleChecked(id)}
                      className="h-3.5 w-3.5 accent-blue-500"
                    />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted">
                    {fmtRelative(it.created_at)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                    {sla ? (
                      <span className={SLA_TONE[sla.tone]}>{sla.label}</span>
                    ) : (
                      // Said as such: a procedure with no time limit is a choice
                      // somebody made, not a number we failed to compute.
                      <span className="text-muted/60">no limit</span>
                    )}
                  </td>
                  <td className="max-w-[16rem] px-2 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
                      <span className="truncate text-foreground">{incTitle(it)}</span>
                      {newIds?.has(id) && (
                        <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-blue-300">
                          New
                        </span>
                      )}
                    </span>
                    <span className="truncate text-[11px] text-muted">{incSopName(it, sopName)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.soft} ${s.text}`}>
                      {s.label}
                    </span>
                  </td>
                  <td className="max-w-[10rem] truncate px-2 py-1.5 text-muted">
                    {incSiteName(it, siteName) || "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        STATUS_TONE[it.status] || "bg-hover text-muted"
                      }`}
                    >
                      {it.current_state_name || it.status}
                    </span>
                  </td>
                  <td className="max-w-[9rem] truncate px-2 py-1.5">
                    {owner ? (
                      <span className="text-foreground">{owner}</span>
                    ) : isOpen(it.status) ? (
                      // The one that gets an operator's attention: an open alarm
                      // nobody owns is the queue's real backlog.
                      <span className="inline-flex items-center gap-1 text-amber-400">
                        <Icon icon="heroicons-outline:user-plus" className="text-xs" />
                        Unassigned
                      </span>
                    ) : (
                      <span className="text-muted/60">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        )}
      </div>
    </section>
  );
}
