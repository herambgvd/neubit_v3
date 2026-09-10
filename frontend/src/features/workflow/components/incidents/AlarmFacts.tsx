"use client";

// WHAT THIS ALARM IS, in the record's own words.
//
// The bento's third column had a clock, three counters and a picture, and then
// several hundred pixels of nothing. This is what belongs in that space: the
// facts an operator checks before acting — which procedure, whose it is, where,
// and what event is behind it.
//
// One rule, the same as everywhere else in this console: NOTHING IS INVENTED. A
// row appears when the record holds the thing. An alarm nobody owns says
// "Unassigned" rather than leaving a blank that reads as "probably fine".
import type { ReactNode } from "react";

import { fmtDateTime } from "@/lib/format";
import type { InstancePublic, NameMap } from "../../types";
import { incAssigneeName, incCameraId, incEventTime, incSiteName, incSopName } from "./lib";

export interface AlarmFactsProps {
  incident: InstancePublic | null;
  sopName?: NameMap;
  siteName?: NameMap;
  cameraName?: string | null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-card-border/60 py-1.5 last:border-0">
      <span className="w-24 shrink-0 text-[11px] text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-[12px] text-foreground">{children}</span>
    </div>
  );
}

/** How the alarm came to exist, said in a way an operator can act on: a rule that
 *  matched, a person who escalated, or somebody raising it from nothing. */
export function originOf(incident: InstancePublic): string {
  const env = (incident.trigger_data || {}) as { raised_by?: unknown; source?: unknown };
  if (env.raised_by === "operator") return "Escalated by an operator";
  const source = incident.event_source;
  if (!source || source === "manual") return "Raised by hand";
  if (source === "vision") return "A rule matched a camera event";
  return `A rule matched a ${source} event`;
}

export default function AlarmFacts({
  incident,
  sopName = {},
  siteName = {},
  cameraName = null,
}: AlarmFactsProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card p-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
        Details
      </span>

      {!incident ? (
        <p className="mt-2 text-[12px] text-muted">
          Pick an alarm — its procedure, owner and the event behind it land here.
        </p>
      ) : (
        <div className="mt-1 min-h-0 flex-1 overflow-y-auto">
          <Row label="Owner">
            {incAssigneeName(incident) || <span className="text-amber-400">Unassigned</span>}
          </Row>
          <Row label="Procedure">{incSopName(incident, sopName) || "—"}</Row>
          {incSiteName(incident, siteName) && (
            <Row label="Site">{incSiteName(incident, siteName)}</Row>
          )}
          {cameraName && <Row label="Camera">{cameraName}</Row>}
          <Row label="Origin">{originOf(incident)}</Row>
          {incEventTime(incident) && (
            <Row label="Event at">
              <span className="font-mono text-[11.5px]">{fmtDateTime(incEventTime(incident))}</span>
            </Row>
          )}
          {incident.event_type && <Row label="Event">{incident.event_type}</Row>}
          {!incCameraId(incident) && (
            <Row label="Evidence">
              <span className="text-muted">No camera behind this one</span>
            </Row>
          )}
          {incident.description && <Row label="Notes">{incident.description}</Row>}
        </div>
      )}
    </div>
  );
}
