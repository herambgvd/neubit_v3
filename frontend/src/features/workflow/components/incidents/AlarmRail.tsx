"use client";

// THE QUEUE — always on screen, down the left.
//
// The bento's own strip of cards only held four and scrolled sideways, which is
// fine while one alarm at a time is true and useless the moment three fire
// together. A rail keeps the whole queue visible beside the alarm being worked,
// so switching between them costs a click and comparing them costs nothing.
//
// Each row is deliberately thin: what it is, how long is left, and who has it.
// The rest of the alarm is the bento's job — repeating it here would make the
// rail a second, worse copy of the case file.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import type { InstancePublic, NameMap } from "../../types";
import { incAssigneeName, incId, incSopName, incTitle, isOpen, sev, slaFor } from "./lib";

export interface AlarmRailProps {
  rows: InstancePublic[];
  selectedId?: string | null;
  onSelect?: (incident: InstancePublic) => void;
  checked: Set<string>;
  onToggleChecked: (id: string) => void;
  sopName?: NameMap;
  newIds?: Set<string>;
  /** Filters + search, above the list. */
  toolbar?: ReactNode;
  /** Paging, under it — the rail scrolls, so this stays put at the bottom. */
  footer?: ReactNode;
  /** Rendered in place of rows when there are none. */
  empty?: ReactNode;
}

const SLA_TONE: Record<string, string> = {
  ok: "text-emerald-400",
  warn: "text-amber-400",
  breach: "text-red-400",
  done: "text-muted",
};

export default function AlarmRail({
  rows,
  selectedId = null,
  onSelect,
  checked,
  onToggleChecked,
  sopName = {},
  newIds,
  toolbar,
  footer,
  empty,
}: AlarmRailProps) {
  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {toolbar && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-card-border p-2">{toolbar}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {rows.length === 0 ? (
          <div className="grid h-full place-items-center p-4">{empty}</div>
        ) : (
          <ul className="grid gap-1">
            {rows.map((it) => {
              const id = incId(it);
              const s = sev(it.priority);
              const sla = slaFor(it);
              const owner = incAssigneeName(it);
              const active = selectedId === id;
              return (
                <li key={id}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-pressed={active}
                    onClick={() => onSelect?.(it)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect?.(it);
                      }
                    }}
                    className={`flex w-full cursor-pointer gap-2 rounded-lg border px-2 py-1.5 text-left transition ${
                      active
                        ? "border-blue-500/50 bg-blue-500/10"
                        : "border-transparent hover:border-card-border hover:bg-hover/60"
                    }`}
                  >
                    <span className={`w-[3px] shrink-0 rounded-full ${s.band}`} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] text-foreground">{incTitle(it)}</span>
                        {newIds?.has(id) && (
                          <span className="shrink-0 rounded-full bg-blue-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-300">
                            New
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2">
                        <span className={`font-mono text-[11px] ${sla ? SLA_TONE[sla.tone] : "text-muted/60"}`}>
                          {sla ? sla.label.replace(/^SLA /, "") : "no limit"}
                        </span>
                        {owner ? (
                          <span className="truncate text-[11px] text-muted">{owner}</span>
                        ) : isOpen(it.status) ? (
                          <span className="inline-flex items-center gap-0.5 text-[11px] text-amber-400">
                            <Icon icon="heroicons-outline:user-plus" className="text-[10px]" /> free
                          </span>
                        ) : null}
                      </span>
                      <span className="truncate text-[10.5px] text-muted/80">{incSopName(it, sopName)}</span>
                    </span>
                    <label className="flex items-start pt-0.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${incTitle(it)}`}
                        checked={checked.has(id)}
                        onChange={() => onToggleChecked(id)}
                        className="h-3.5 w-3.5 accent-blue-500"
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {footer && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-card-border px-2 py-1.5">
          {footer}
        </div>
      )}
    </aside>
  );
}
