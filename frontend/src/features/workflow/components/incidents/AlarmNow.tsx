"use client";

// WORKING NOW — the alarm that owns the screen.
//
// The big cell of the bento: the footage from the moment the alarm was raised
// from, and under it the alarm's identity plus the actions that are not part of
// the procedure — taking it, handing it to somebody, opening the full case.
// Moving the alarm ALONG its procedure belongs to ProcedureSteps, because those
// moves come from the SOP rather than from this screen.
//
// The picture is the point: an alarm console that describes an event and sends
// the operator elsewhere to look has the job backwards.
import Link from "next/link";
import { Icon } from "@iconify/react";

import type { EstateCamera } from "@/features/vms/types";
import { fmtDateTime } from "@/lib/format";
import type { InstancePublic, NameMap } from "../../types";
import { EvidencePicture, type EvidenceKind } from "./AlarmEvidence";
import { incCameraId, incEventTime, incId, incSiteName, incTitle, isOpen, sev } from "./lib";

export interface AlarmNowProps {
  incident: InstancePublic | null;
  camera: EstateCamera | null;
  siteName?: NameMap;
  /** Which picture has the big cell — the parent owns it, because the small cell
   *  shows the other one. */
  kind: EvidenceKind;
  onKindChange?: (kind: EvidenceKind) => void;
  /** The recording says whether the window holds anything; the parent uses it to
   *  hand the space to live rather than to a black rectangle. */
  onFootage?: (present: boolean) => void;
  onTake?: (incident: InstancePublic) => void;
  onAssign?: (incident: InstancePublic) => void;
  takePending?: boolean;
}

export default function AlarmNow({
  incident,
  camera,
  siteName = {},
  kind,
  onKindChange,
  onFootage,
  onTake,
  onAssign,
  takePending = false,
}: AlarmNowProps) {
  const s = incident ? sev(incident.priority) : null;
  const cameraId = incident ? incCameraId(incident) : null;
  const eventTime = incident ? incEventTime(incident) : null;
  const open = !!incident && isOpen(incident.status);
  const hasPicture = !!incident && !!camera;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* The video keeps 16:9 and the card is as tall as that plus its footer.
          Stretching it to fill a column just painted a black band under the
          picture — which was most of what the first build showed. */}
      <div className={`relative aspect-video w-full ${hasPicture ? "bg-black" : ""}`}>
        <EvidencePicture incident={incident} camera={camera} kind={kind} onFootage={onFootage} />

        {/* WHICH PICTURE, over the picture itself — one click, and it stays where
            the operator's eye already is. */}
        {hasPicture && onKindChange && (
          <div className="absolute right-2 top-2 z-10 inline-flex overflow-hidden rounded-lg border border-card-border bg-[rgba(8,15,34,.82)] backdrop-blur-xs">
            {(["recording", "live"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onKindChange(k)}
                aria-pressed={kind === k}
                className={`px-2.5 py-1 text-[11px] font-medium transition ${
                  kind === k ? "bg-blue-500/20 text-blue-100" : "text-muted hover:text-foreground"
                }`}
              >
                {k === "recording" ? "Recording" : "Live"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!incident && (
        <div className="shrink-0 border-t border-card-border px-3 py-2.5 text-[11.5px] text-muted">
          Pick an alarm from the queue — it takes this cell, with its clock and its next step.
        </div>
      )}
      {incident && s && (

      <div className="grid shrink-0 gap-2 border-t border-card-border px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-4 w-[3px] shrink-0 rounded-full ${s.band}`} aria-hidden />
          <h2 className="min-w-0 truncate text-[15px] font-semibold text-foreground">{incTitle(incident)}</h2>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${s.soft} ${s.text}`}>
            {s.label}
          </span>
          <span className="rounded-full bg-hover px-1.5 py-0.5 text-[10px] text-foreground">
            {incident.current_state_name || incident.status}
          </span>
          {incSiteName(incident, siteName) && (
            <span className="truncate text-[11.5px] text-muted">{incSiteName(incident, siteName)}</span>
          )}
          <span className="ml-auto font-mono text-[11px] text-muted">
            raised {fmtDateTime(incident.created_at)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {open && incident.status === "pending" && onTake && (
            <button
              type="button"
              onClick={() => onTake(incident)}
              disabled={takePending}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11.5px] font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Icon icon="heroicons-outline:check" className="text-xs" /> Take it
            </button>
          )}
          {open && onAssign && (
            <button
              type="button"
              onClick={() => onAssign(incident)}
              className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:user-plus" className="text-xs" />
              {incident.assigned_to ? "Reassign" : "Assign"}
            </button>
          )}
          <Link
            href={`/alarms/${encodeURIComponent(incId(incident))}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:folder-open" className="text-xs" /> Open case
          </Link>
          {cameraId && eventTime && (
            <Link
              href={`/playback?camera=${encodeURIComponent(cameraId)}&t=${encodeURIComponent(eventTime)}`}
              title="Open this camera's whole timeline in Playback"
              className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1.5 text-[11.5px] text-muted transition hover:bg-hover hover:text-foreground"
            >
              <Icon icon="heroicons-outline:film" className="text-xs" /> Timeline
            </Link>
          )}
        </div>
      </div>
      )}
    </section>
  );
}
