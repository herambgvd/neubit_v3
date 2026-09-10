"use client";

// WHO DID WHAT, AND WHEN.
//
// The slot beside the clock held a counters card that repeated the chips already
// in the top bar — a console that prints the same number twice makes an operator
// check which one is right. This is what belongs there instead: the alarm's own
// history, which exists on every incident (`timeline`, appended by
// InstanceService.transition) and was visible nowhere.
//
// It answers the question a second operator arrives with: has anybody looked at
// this, and what did they find. The note somebody was made to write when they
// resolved or dismissed is here — which is the only reason making them write it
// was worth anything.
import { Icon } from "@iconify/react";

import { fmtDateTime } from "@/lib/format";
import type { InstancePublic } from "../../types";
import { originOf } from "./AlarmFacts";

export interface AlarmTrailProps {
  incident: InstancePublic | null;
}

export default function AlarmTrail({ incident }: AlarmTrailProps) {
  // Newest first: what happened last is what a person arriving now needs.
  const entries = [...(incident?.timeline || [])].sort((a, b) =>
    String(b.executed_at || "").localeCompare(String(a.executed_at || "")),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
        Trail
      </span>

      {!incident ? (
        <p className="mt-2 text-[12px] text-muted">Pick an alarm to see what has been done to it.</p>
      ) : (
        <div className="mt-1.5 grid min-h-0 flex-1 content-start gap-2 overflow-y-auto">
          {entries.map((e, i) => (
            <div key={`${e.transition_id}-${e.executed_at}-${i}`} className="grid gap-0.5">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-[12px] text-foreground">
                  {e.transition_name || `${e.from_state_name} → ${e.to_state_name}`}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">
                  {fmtDateTime(e.executed_at)}
                </span>
              </span>
              <span className="text-[11px] text-muted">
                {e.executed_by_name || e.executed_by || "somebody"}
                {e.to_state_name ? ` · now ${e.to_state_name}` : ""}
              </span>
              {e.notes && (
                // The reason a required note is worth requiring.
                <span className="rounded-md border border-card-border bg-hover/40 px-2 py-1 text-[11px] text-foreground/90">
                  {e.notes}
                </span>
              )}
            </div>
          ))}

          {/* The first entry is always true and never in the timeline: the alarm
              had to come from somewhere. */}
          <div className="grid gap-0.5 border-t border-card-border/60 pt-2 first:border-0 first:pt-0">
            <span className="flex items-baseline gap-2">
              <span className="inline-flex items-center gap-1.5 text-[12px] text-foreground">
                <Icon icon="heroicons-outline:bolt" className="text-xs text-amber-400" />
                Raised
              </span>
              <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">
                {fmtDateTime(incident.created_at)}
              </span>
            </span>
            <span className="text-[11px] text-muted">{originOf(incident)}</span>
          </div>

          {entries.length === 0 && (
            <p className="text-[11px] text-muted">
              Nothing has been done to it yet — it is waiting for somebody.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
