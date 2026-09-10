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
import { useMemo } from "react";
import { Icon } from "@iconify/react";

import LivePlayer from "@/features/vms/components/LivePlayer";
import TilePlayback from "@/features/vms/components/TilePlayback";
import { vms } from "@/features/vms/api";
import type { EstateCamera, LiveSessionSource } from "@/features/vms/types";
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
}: EvidencePictureProps) {
  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;

  const liveSource = useMemo<LiveSessionSource | null>(() => {
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
      anchorMs={eventMs - PRE_ROLL_MS}
      anchorSeq={eventMs}
      windowToMs={eventMs + POST_ROLL_MS}
      playing
      muted
      compact={compact}
      onFootage={onFootage}
    />
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
