"use client";

// THE ON-PAGE HALF OF ALARM NOTIFICATION — the video an operator came here for.
//
// Every enterprise VMS puts the alarm list beside a canvas that switches to the
// alarm's camera, and this is that canvas. It carries three things, in the order
// an operator asks for them:
//
//   1. WHAT and WHERE — the type, the camera, the severity, and the recorder's own
//      reason out of the payload (`connection refused ×3`), not the transport name;
//   THE PICTURE — and by default that is the RECORDING, starting a few seconds
//      before the event and running past it. An operator opening an alarm wants to
//      see what happened, not what is happening now; live is one click away for
//      when the answer is "is it still going on?".
//
//      The recording plays HERE. It used to be a link to the Playback console,
//      which is a different page, a different query to compose and a lost place in
//      the feed — for the single question this pane exists to answer.
//
//      When the camera is the thing that broke, live is exactly what cannot be
//      shown, so that branch says so in the recorder's own sentence rather than
//      painting a black rectangle;
//   3. THE MOVE — acknowledge, open the incident this event raised, or take the
//      whole investigation to Playback when one clip is not enough.
//
// AUTO-FOLLOW is the behaviour that makes it a monitoring surface rather than a
// list with a viewer attached: an incoming alarm takes the canvas. It is a toggle,
// and it only ever follows an ATTENTION severity — a canvas that jumps to a
// heartbeat is a canvas an operator turns off.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { vms } from "../api";
import { sevPreset, eventTypeLabel, typePreset, fmtTime, type NormalizedVmsEvent } from "../eventLib";
import type { EstateCamera, LiveSessionSource } from "../types";
import LivePlayer from "./LivePlayer";
import TilePlayback from "./TilePlayback";

// The alarm clip's shape: a few seconds before the event so the operator sees it
// begin, and a minute after so they see what it became. Standard pre/post buffer,
// and the reason the pane opens on the recording rather than on live.
const PRE_ROLL_MS = 8_000;
const POST_ROLL_MS = 60_000;

export interface EventMonitorPaneProps {
  event: NormalizedVmsEvent | null;
  /** The camera as the ESTATE knows it — the recorder that owns it and the id it
   *  answers to there. Without both there is neither a live session nor a
   *  recorded one to mint. */
  camera: EstateCamera | null;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
}

/** The recorder's own words for why, dug out of the payload it sent. A row that
 *  prints "ONVIF_PULLPOINT" tells an operator the transport; this tells them the
 *  fault. */
function reasonOf(event: NormalizedVmsEvent): string | null {
  const raw = (event.raw || {}) as Record<string, unknown>;
  const payload = (raw.payload || {}) as Record<string, unknown>;
  const reason = payload.reason ?? raw.reason;
  if (typeof reason === "string" && reason.trim()) return reason.trim();
  const status = payload.status;
  return typeof status === "string" && status.trim() ? status.trim() : null;
}

export default function EventMonitorPane({
  event,
  camera,
  follow,
  onFollowChange,
}: EventMonitorPaneProps) {
  // A node-issued live session, minted through the owning recorder — the same
  // path the wall and the camera detail use. Keyed on the pair so switching
  // events re-mints exactly once.
  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;
  // RECORDING first: the operator opened an alarm to see what happened. Live
  // answers a different question ("is it still going on?") and is one click away.
  const [mode, setMode] = useState<"recording" | "live">("recording");
  const source = useMemo<LiveSessionSource | null>(() => {
    if (!nodeId || !realId) return null;
    const mint = async (profile: string) => {
      const s = await vms.federation.live(nodeId, realId, profile);
      return { ...s, ready: true };
    };
    return {
      start: (_camId, profile) => mint(profile),
      renew: () => mint("sub"),
      release: async () => {},
    };
  }, [nodeId, realId]);

  const followToggle = (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-[11px] text-muted transition hover:text-foreground"
      title="Switch this pane to each new alarm as it arrives"
    >
      <input
        type="checkbox"
        className="h-3 w-3 accent-blue-500"
        checked={follow}
        onChange={(e) => onFollowChange(e.target.checked)}
      />
      <span>Follow alarms</span>
    </label>
  );

  if (!event) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
        {/* shrink-0, and the row below scrolls nothing: a 22rem minimum here used
            to push this card past the bounded evidence row and over the table. */}
        <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
          <Icon icon="heroicons:play-circle" className="text-sm text-blue-500" />
          <span className="text-[12px] font-semibold text-foreground">Monitor</span>
          <span className="ml-auto">{followToggle}</span>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon icon="heroicons-outline:video-camera" className="text-3xl text-muted opacity-50" />
          <p className="text-[12.5px] text-foreground">No event selected</p>
          <p className="max-w-xs text-[11px] text-muted">
            Pick one from the feed to see its camera live — or leave Follow alarms on and the
            next one takes this pane.
          </p>
        </div>
      </div>
    );
  }

  const sp = sevPreset(event.severity);
  const tp = typePreset(event.event_type);
  const reason = reasonOf(event);
  // KNOWN to be down, not merely unheard-of. A camera whose status has not
  // arrived yet is not a camera that is offline, and saying "not streaming"
  // because a list is still loading is the same class of lie as an empty timeline
  // for an unreachable recorder. Unknown → try the stream and let the player
  // report what actually happens.
  const offline = camera?.status ? String(camera.status).toLowerCase() !== "online" : false;
  const eventMs = event.occurred_at ? new Date(event.occurred_at).getTime() : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {/* what + where */}
      <header className="flex flex-wrap items-center gap-2 border-b border-card-border px-3 py-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${sp.dot}`} />
        <Icon icon={tp.icon} className={`text-sm ${sp.text}`} />
        <span className="text-[12.5px] font-semibold text-foreground">
          {eventTypeLabel(event.event_type)}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${sp.cls}`}>{sp.label}</span>
        <span className="truncate text-[12px] text-muted">{camera?.name || event.title}</span>
        <span className="ml-auto">{followToggle}</span>
      </header>

      {/* the picture — the recording, at the event's own instant */}
      <div className="relative min-h-0 w-full flex-1 bg-black">
        {mode === "recording" ? (
          eventMs != null && camera ? (
            // Anchored a few seconds BEFORE the event so it is seen beginning.
            // `TilePlayback` mints the recorded session from the owning recorder
            // and says so itself when the window holds no footage.
            <TilePlayback
              key={`${camera.id}:${eventMs}`}
              camera={camera}
              anchorMs={eventMs - PRE_ROLL_MS}
              anchorSeq={eventMs}
              windowToMs={eventMs + POST_ROLL_MS}
              playing
              muted
              compact
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted">
              This event carries no timestamp, so there is no moment to play.
            </div>
          )
        ) : source && !offline ? (
          <LivePlayer
            key={`${nodeId}:${realId}`}
            cameraId={camera?.id}
            cameraName={camera?.name}
            nodeId={nodeId}
            source={source}
            profile="sub"
            autoPlay
            muted
            fit="contain"
          />
        ) : (
          // A camera that is DOWN is the one case where live cannot be shown, and
          // it is exactly when an operator is looking. Say which, in the
          // recorder's own words — the recording from before it went is still
          // there, one click back.
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon icon="heroicons-outline:video-camera-slash" className="text-3xl text-red-400/70" />
            <p className="text-[12.5px] text-foreground">
              {offline ? "This camera is not streaming" : "No live source for this camera"}
            </p>
            {reason && <p className="max-w-md break-words font-mono text-[11px] text-muted">{reason}</p>}
            <button
              type="button"
              onClick={() => setMode("recording")}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-card-border px-2.5 py-1 text-[11px] text-muted transition hover:text-foreground"
            >
              <Icon icon="heroicons-outline:play" className="text-xs" />
              Play the recording from this moment
            </button>
          </div>
        )}
      </div>

      {/* Recording ⇄ Live. Two words, because they answer two different
          questions: what happened, and whether it still is. */}
      <div className="flex items-center gap-1 border-b border-card-border px-3 py-1.5">
        <ModeButton active={mode === "recording"} onClick={() => setMode("recording")} icon="heroicons-outline:play">
          Recording
        </ModeButton>
        <ModeButton active={mode === "live"} onClick={() => setMode("live")} icon="heroicons:signal">
          Live
        </ModeButton>
        {mode === "recording" && eventMs != null && (
          <span className="ml-auto font-mono text-[10.5px] text-muted">
            from {fmtTime(new Date(eventMs - PRE_ROLL_MS).toISOString())}
          </span>
        )}
      </div>

    </div>
  );
}

function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition ${
        active
          ? "bg-blue-500/15 text-blue-300"
          : "text-muted hover:bg-hover hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className="text-xs" />
      {children}
    </button>
  );
}
