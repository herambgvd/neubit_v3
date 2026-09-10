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

import TilePlayback from "@/features/vms/components/TilePlayback";
import type { EstateCamera } from "@/features/vms/types";
import { fmtDateTime } from "@/lib/format";
import type { InstancePublic, NameMap } from "../../types";
import { incCameraId, incEventTime, incId, incSiteName, incTitle, isOpen, sev } from "./lib";

/** Seen beginning, and seen becoming — the same buffer the events console uses. */
const PRE_ROLL_MS = 8_000;
const POST_ROLL_MS = 60_000;

export interface AlarmNowProps {
  incident: InstancePublic | null;
  camera: EstateCamera | null;
  siteName?: NameMap;
  onTake?: (incident: InstancePublic) => void;
  onAssign?: (incident: InstancePublic) => void;
  takePending?: boolean;
}

function Blank({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon icon={icon} className="text-3xl text-muted opacity-40" />
      <p className="text-[12.5px] text-foreground">{title}</p>
      <p className="max-w-sm text-[11px] text-muted">{body}</p>
    </div>
  );
}

export default function AlarmNow({
  incident,
  camera,
  siteName = {},
  onTake,
  onAssign,
  takePending = false,
}: AlarmNowProps) {
  if (!incident) {
    return (
      <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
        <Blank
          icon="heroicons-outline:cursor-arrow-rays"
          title="No alarm selected"
          body="Pick one from the queue and it takes this cell — its footage, its clock and its next step."
        />
      </section>
    );
  }

  const s = sev(incident.priority);
  const cameraId = incCameraId(incident);
  const eventTime = incEventTime(incident);
  const eventMs = eventTime ? new Date(eventTime).getTime() : NaN;
  const open = isOpen(incident.status);
  const playable = !!cameraId && !!camera && Number.isFinite(eventMs);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <div className={`relative min-h-0 flex-1 ${playable ? "bg-black" : ""}`}>
        {playable ? (
          <TilePlayback
            key={`${camera!.id}:${eventMs}`}
            camera={camera!}
            anchorMs={eventMs - PRE_ROLL_MS}
            anchorSeq={eventMs}
            windowToMs={eventMs + POST_ROLL_MS}
            playing
            muted
            compact
          />
        ) : !cameraId ? (
          <Blank
            icon="heroicons-outline:document-text"
            title="No camera on this alarm"
            body="It was raised without a camera event behind it, so there is no footage to point at."
          />
        ) : !camera ? (
          // NOT the same as "no footage": the recorder that owns this camera is
          // not answering. Saying "nothing recorded" sends an operator looking for
          // a fault in the wrong place.
          <Blank
            icon="heroicons-outline:signal-slash"
            title="Camera not reachable from here"
            body="The alarm names a camera this console cannot resolve — check the recorder is federated and online."
          />
        ) : (
          <Blank
            icon="heroicons-outline:clock"
            title="No moment to play"
            body="This alarm carries no event time, so there is no instant to open the recording at."
          />
        )}
      </div>

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
    </section>
  );
}
