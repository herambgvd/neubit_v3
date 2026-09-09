"use client";

// THE EVENT TABLE — one table, dense, scannable, selectable, paged.
//
// It was a table PER DAY, each with its own header and its own select-all. That
// is three headers on a screen showing seventeen rows, and an operator who wants
// "everything on Channel 5" reads it in pieces. One table, one set of columns,
// one toolbar, and the date on every row.
//
// The feed was a stack of cards. Cards are right for a handful of things and
// wrong for a shift's worth: a card repeats every label on every row, so eight
// events fill a screen that a table would hold thirty of, and the eye has no
// column to run down. Every alarm console converges on a table for the same
// reason, and this one carries the columns an operator actually triages by:
// when, how long, what, how bad, where, and whether anyone has taken it.
//
// CHECKBOXES ARE FOR THE BURST. Twenty-nine of the fifty-nine events on this
// estate are motion from one camera; acknowledging them one row at a time is the
// work the console should be doing. Select, acknowledge, done.
//
// The row is also the SELECTOR for the evidence above it, so a click has two
// jobs: it is the ordinary way to look at something, and the checkbox is the way
// to act on many. They never fight — the checkbox stops the click from reaching
// the row.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import { eventTypeLabel, fmtDate, fmtTime, sevPreset, typePreset, type NormalizedVmsEvent } from "../eventLib";
import { durationLabel, eventInterval } from "../eventState";
import { useTicker } from "../hooks/useTicker";

export interface EventTableProps {
  /** The page's rows — already filtered and paged by the caller. */
  events: NormalizedVmsEvent[];
  selectedId?: string | null;
  onSelect?: (event: NormalizedVmsEvent) => void;
  checked: Set<string>;
  onToggleChecked: (key: string) => void;
  onToggleAll: () => void;
  cameraName?: (id: string | null | undefined) => string | null;
  /** The toolbar's own controls — filters live IN the table, where the rows they
   *  narrow are, rather than in a separate card above the evidence panels. */
  toolbar?: ReactNode;
  /** Paging, rendered under the rows. */
  footer?: ReactNode;
}

const keyOf = (e: NormalizedVmsEvent) => e.event_id || e.id || "";

export default function EventTable({
  events,
  selectedId = null,
  onSelect,
  checked,
  onToggleChecked,
  onToggleAll,
  cameraName,
  toolbar,
  footer,
}: EventTableProps) {
  // One clock for the whole table: the open rows count up together, and a ticker
  // per row would be a timer per row.
  const now = useTicker(1_000, events.some((e) => eventInterval(e).open));

  const allChecked = events.length > 0 && events.every((e) => checked.has(keyOf(e)));

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-card">
      {toolbar && (
        <header className="flex flex-wrap items-center gap-2 border-b border-card-border px-3 py-2">
          {toolbar}
        </header>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left">
          <thead>
            <tr className="border-b border-card-border text-[10px] uppercase tracking-wide text-muted">
              <th className="w-8 px-2 py-1.5">
                <input
                  type="checkbox"
                  aria-label={allChecked ? "Clear selection" : "Select all in this group"}
                  checked={allChecked}
                  onChange={onToggleAll}
                  className="h-3.5 w-3.5 accent-blue-500"
                />
              </th>
              <th className="px-2 py-1.5 font-medium">When</th>
              <th className="px-2 py-1.5 font-medium">Duration</th>
              <th className="px-2 py-1.5 font-medium">Event</th>
              <th className="px-2 py-1.5 font-medium">Severity</th>
              <th className="px-2 py-1.5 font-medium">Camera</th>
              <th className="px-2 py-1.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-card-border/60">
            {events.map((e) => {
              const key = keyOf(e);
              const sp = sevPreset(e.severity);
              const tp = typePreset(e.event_type);
              const iv = eventInterval(e);
              const duration = durationLabel(e, now);
              const isSelected = !!selectedId && selectedId === key;
              return (
                <tr
                  key={key}
                  onClick={() => onSelect?.(e)}
                  aria-selected={isSelected}
                  className={`cursor-pointer text-[12px] transition ${
                    isSelected ? "bg-blue-500/10" : "hover:bg-hover/60"
                  }`}
                >
                  <td className="px-2 py-1.5" onClick={(ev) => ev.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${eventTypeLabel(e.event_type)} on ${cameraName?.(e.camera_id) || e.title || "camera"}`}
                      checked={checked.has(key)}
                      onChange={() => onToggleChecked(key)}
                      className="h-3.5 w-3.5 accent-blue-500"
                    />
                  </td>
                  {/* The date rides on every row now: without the day groups
                      there is no header carrying it, and a time with no date is
                      the one thing a shift-long feed must never print. */}
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted">
                    <span className="text-foreground">{fmtTime(e.occurred_at)}</span>
                    <span className="ml-1.5 text-[10px]">{fmtDate(e.occurred_at)}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono">
                    {duration ? (
                      <span className={iv.open ? "text-orange-300" : iv.invalid ? "italic text-muted" : "text-muted"}>
                        {duration}
                      </span>
                    ) : (
                      // An instantaneous event, said as such rather than as "0s".
                      <span className="text-muted/60">instant</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <Icon icon={tp.icon} className={`text-sm ${sp.text}`} />
                      {eventTypeLabel(e.event_type)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>
                      {sp.label}
                    </span>
                  </td>
                  <td className="max-w-[12rem] truncate px-2 py-1.5 text-foreground">
                    {cameraName?.(e.camera_id) || e.title || "—"}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    {iv.open ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                        Ongoing
                      </span>
                    ) : e.acknowledged ? (
                      <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
                        Acked
                      </span>
                    ) : (
                      <span className="rounded-full border border-card-border px-1.5 py-0.5 text-[10px] text-muted">
                        Open
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {footer && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-card-border px-3 py-2">
          {footer}
        </footer>
      )}
    </section>
  );
}
