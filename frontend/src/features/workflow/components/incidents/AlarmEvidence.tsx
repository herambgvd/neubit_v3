"use client";

// THE TWO PICTURES AN ALARM HAS, and the rule for which one gets the big cell.
//
// An alarm's evidence is the RECORDING at the moment it was raised from, and the
// camera LIVE. Which of the two matters depends on the alarm: for one that fired
// four hours ago the recording is the story; for one firing right now, live is.
//
// And sometimes the recording does not exist — the recorder was not recording
// that camera then. The first build gave the recording the big cell
// unconditionally, so on this estate the largest thing on the console was a black
// rectangle reading "No footage at this time" while the live view, which had a
// picture, sat in the smallest tile on the page. That is the layout upside down.
//
// So: the big cell shows the recording when there IS footage and live when there
// is not, the operator can override with one click, and whichever picture is not
// in the big cell is the one in the small one. The space is never dead.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import LivePlayer from "@/features/vms/components/LivePlayer";
import TilePlayback from "@/features/vms/components/TilePlayback";
import { vms } from "@/features/vms/api";
import { createClock } from "@/features/vms/hooks/useWallPlayback";
import { useNodeLiveSource } from "@/features/vms/hooks/useNodeLiveSource";
import type { EstateCamera, PlaybackRange } from "@/features/vms/types";
import RecordingScrubber from "./RecordingScrubber";
import type { InstancePublic } from "../../types";
import { incCameraId, incEventTime } from "./lib";

/** Seen beginning, and seen becoming — the same buffer the events console uses. */
export const PRE_ROLL_MS = 8_000;
export const POST_ROLL_MS = 60_000;

export type EvidenceKind = "recording" | "live";

export interface EvidencePictureProps {
  incident: InstancePublic | null;
  camera: EstateCamera | null;
  kind: EvidenceKind;
  /** Only the recording reports this; live has no such state. */
  onFootage?: (present: boolean) => void;
  compact?: boolean;
  /** Seek, in ms — set by the transport bar. Absent = play from the event. */
  anchorMs?: number | null;
  anchorSeq?: number;
  playing?: boolean;
  speed?: number;
  /** Publishes where the video actually is, for the bar above it to follow. */
  clock?: ReturnType<typeof createClock> | null;
}

function Blank({ icon, title, body }: { icon: string; title: string; body?: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1.5 p-5 text-center">
      <Icon icon={icon} className="text-2xl text-muted opacity-40" />
      <p className="text-[12.5px] text-foreground">{title}</p>
      {body && <p className="max-w-sm text-[11px] text-muted">{body}</p>}
    </div>
  );
}

/** The picture itself, with no card around it — so the big cell and the small one
 *  render the same thing at two sizes rather than drifting apart. */
export function EvidencePicture({
  incident,
  camera,
  kind,
  onFootage,
  compact = false,
  anchorMs = null,
  anchorSeq,
  playing = true,
  speed = 1,
  clock = null,
}: EvidencePictureProps) {
  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;
  const liveSource = useNodeLiveSource(camera);

  if (!incident) {
    return (
      <Blank
        icon="heroicons-outline:cursor-arrow-rays"
        title="No alarm selected"
        body="Pick one from the queue and its evidence lands here."
      />
    );
  }

  const cameraId = incCameraId(incident);
  if (!cameraId) {
    return (
      <Blank
        icon="heroicons-outline:document-text"
        title="No camera on this alarm"
        body="It was raised without a camera event behind it, so there is nothing to look at."
      />
    );
  }
  if (!camera) {
    // NOT the same as "no footage": the recorder that owns this camera is not
    // answering. Saying "nothing recorded" sends an operator after the wrong fault.
    return (
      <Blank
        icon="heroicons-outline:signal-slash"
        title="Camera not reachable from here"
        body="Check the recorder is federated and online."
      />
    );
  }

  if (kind === "live") {
    // KNOWN to be down, not merely unheard-of: a status that has not arrived is
    // not a camera that is offline.
    const offline = camera.status ? String(camera.status).toLowerCase() !== "online" : false;
    if (!liveSource || offline) {
      return (
        <Blank
          icon="heroicons-outline:video-camera-slash"
          title={offline ? "Not streaming right now" : "No live source for this camera"}
        />
      );
    }
    return (
      // ABSOLUTE, like the recording tile. LivePlayer's root is an in-flow box
      // whose height follows the stream, so inside an `aspect-video` frame it
      // pushed the frame taller than 16:9 — which is why the live card sat lower
      // than the recording beside it. Pinned to the frame, both cards are the
      // same height and the picture letterboxes inside rather than stretching it.
      <LivePlayer
        key={`${nodeId}:${realId}`}
        cameraId={camera.id}
        cameraName={camera.name}
        nodeId={nodeId}
        source={liveSource}
        profile="sub"
        autoPlay
        muted
        fit="contain"
        className="absolute inset-0 h-full w-full"
      />
    );
  }

  const eventTime = incEventTime(incident);
  const eventMs = eventTime ? new Date(eventTime).getTime() : NaN;
  if (!Number.isFinite(eventMs)) {
    return (
      <Blank
        icon="heroicons-outline:clock"
        title="No moment to play"
        body="This alarm carries no event time, so there is no instant to open the recording at."
      />
    );
  }

  return (
    <TilePlayback
      key={`${camera.id}:${eventMs}`}
      camera={camera}
      anchorMs={anchorMs ?? eventMs - PRE_ROLL_MS}
      anchorSeq={anchorSeq ?? eventMs}
      windowToMs={eventMs + POST_ROLL_MS}
      playing={playing}
      speed={speed}
      muted
      compact={compact}
      onFootage={onFootage}
      master={!!clock}
      clock={clock}
    />
  );
}

/** The window the case plays: a run-up before the event, and the minute after. */
export function evidenceWindow(incident: InstancePublic): { fromMs: number; toMs: number; eventMs: number } | null {
  const at = incEventTime(incident);
  const eventMs = at ? new Date(at).getTime() : NaN;
  if (!Number.isFinite(eventMs)) return null;
  return { fromMs: eventMs - PRE_ROLL_MS, toMs: eventMs + POST_ROLL_MS, eventMs };
}

/** THE RECORDING, WITH ITS TRANSPORT. State lives here — a seek is a new anchor,
 *  so the bar and the tile cannot disagree about where the video is. */
export function RecordingWithTransport({
  incident,
  camera,
  onFootage,
}: {
  incident: InstancePublic | null;
  camera: EstateCamera | null;
  onFootage?: (present: boolean) => void;
}) {
  const win = incident ? evidenceWindow(incident) : null;
  // useState, not useRef: the clock is READ during render (the transport
  // subscribes to it), and a ref read in render is the thing the compiler
  // refuses. A lazy initializer gives the same one-per-mount value.
  const [clock] = useState(createClock);
  const [anchorMs, setAnchorMs] = useState<number | null>(null);
  const [seq, setSeq] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);

  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;

  // What the recorder actually holds across this window. Without it the bar
  // cannot tell "nothing recorded" from "nothing happened" — which is the whole
  // reason to draw one on an estate that does not record every camera.
  const coverageQ = useQuery({
    queryKey: ["alarm-coverage", nodeId, realId, win?.fromMs, win?.toMs],
    queryFn: () =>
      vms.federation.timeline(nodeId!, realId!, {
        from: new Date(win!.fromMs).toISOString(),
        to: new Date(win!.toMs).toISOString(),
      }),
    enabled: !!nodeId && !!realId && !!win,
    retry: false,
    staleTime: 60_000,
  });
  const ranges = (coverageQ.data?.ranges || []) as PlaybackRange[];

  return (
    <>
      <div className={`relative aspect-video w-full ${incident && camera ? "bg-black" : ""}`}>
        <EvidencePicture
          incident={incident}
          camera={camera}
          kind="recording"
          onFootage={onFootage}
          anchorMs={anchorMs}
          anchorSeq={seq}
          playing={playing}
          speed={speed}
          clock={clock}
        />
        {/* OVER the picture, the way every player puts its transport — and the
            reason it is not a strip UNDER it: the live card beside this one has
            no transport to match, and two exhibits of different heights was the
            thing being fixed when this was added. */}
        {win && camera && (
          <div className="absolute inset-x-0 bottom-0 z-10 bg-[rgba(8,15,34,.82)] backdrop-blur-xs">
        <RecordingScrubber
          fromMs={win.fromMs}
          toMs={win.toMs}
          eventMs={win.eventMs}
          clock={clock}
          playing={playing}
          speed={speed}
          ranges={ranges}
          onSeek={(ms) => {
            setAnchorMs(ms);
            setSeq((n) => n + 1);
            clock.set(ms);
          }}
          onPlayingChange={setPlaying}
          onSpeedChange={setSpeed}
        />
          </div>
        )}
      </div>
    </>
  );
}

export interface AlarmEvidenceCardProps extends EvidencePictureProps {
  /** Swap this card's picture with the big cell's. */
  onPromote?: () => void;
}

/** The SMALL evidence cell — whichever picture the big cell is not showing. */
export default function AlarmEvidenceCard({
  incident,
  camera,
  kind,
  onPromote,
  onFootage,
}: AlarmEvidenceCardProps) {
  const live = kind === "live";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon
          icon={live ? "heroicons:signal" : "heroicons:play-circle"}
          className={`text-sm ${live ? "text-emerald-400" : "text-blue-500"}`}
        />
        <span className="text-[12px] font-semibold text-foreground">
          {live ? "Live view" : "Recording"}
        </span>
        {camera?.name && <span className="truncate text-[11px] text-muted">{camera.name}</span>}
        {onPromote && (
          <button
            type="button"
            onClick={onPromote}
            title="Show this one large"
            aria-label={live ? "Show live large" : "Show the recording large"}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:arrows-pointing-out" className="text-xs" />
          </button>
        )}
      </header>
      {/* ASPECT, not fill. A 16:9 stream inside a taller cell paints the
          difference black, and the page ends up mostly black band. Let the video
          say how tall it is and give the leftover height to something with
          content in it. */}
      <div className={`relative aspect-video w-full ${incident && camera ? "bg-black" : ""}`}>
        <EvidencePicture
          incident={incident}
          camera={camera}
          kind={kind}
          onFootage={onFootage}
          compact
        />
      </div>
    </div>
  );
}
