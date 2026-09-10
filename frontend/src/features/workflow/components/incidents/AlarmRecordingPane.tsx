"use client";

// THE PICTURE — what the camera recorded at the moment the alarm was raised from.
//
// An alarm console that describes an event and makes the operator go somewhere
// else to look at it has got the job backwards: they are here to look. So the
// pane opens on the RECORDING at the source event's own instant, a few seconds
// before it so the thing is seen beginning.
//
// It is honest about the three ways it can have nothing to show, because they
// mean different things: an alarm raised by hand has no event, an event may name
// no camera, and a camera the estate cannot resolve is a federation problem
// rather than an empty recorder.
import { Icon } from "@iconify/react";

import TilePlayback from "@/features/vms/components/TilePlayback";
import type { EstateCamera } from "@/features/vms/types";
import type { InstancePublic } from "../../types";
import { incCameraId, incEventTime } from "./lib";

/** Seen beginning, and seen becoming: the same buffer the events console uses. */
const PRE_ROLL_MS = 8_000;
const POST_ROLL_MS = 60_000;

export interface AlarmRecordingPaneProps {
  incident: InstancePublic | null;
  /** The camera as the ESTATE knows it — without the owning recorder there is no
   *  recorded session to mint. */
  camera: EstateCamera | null;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      {children}
    </div>
  );
}

function Header({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
      <Icon icon="heroicons:play-circle" className="text-sm text-blue-500" />
      <span className="text-[12px] font-semibold text-foreground">{label}</span>
      {right && <span className="ml-auto truncate text-[11px] text-muted">{right}</span>}
    </header>
  );
}

function Empty({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon icon={icon} className="text-3xl text-muted opacity-40" />
      <p className="text-[12.5px] text-foreground">{title}</p>
      <p className="max-w-xs text-[11px] text-muted">{body}</p>
    </div>
  );
}

export default function AlarmRecordingPane({ incident, camera }: AlarmRecordingPaneProps) {
  if (!incident) {
    return (
      <Frame>
        <Header label="Recording" />
        <Empty
          icon="heroicons-outline:video-camera"
          title="No alarm selected"
          body="Pick one from the list and this pane plays what its camera recorded at the time."
        />
      </Frame>
    );
  }

  const cameraId = incCameraId(incident);
  const eventTime = incEventTime(incident);
  const eventMs = eventTime ? new Date(eventTime).getTime() : NaN;

  if (!cameraId) {
    return (
      <Frame>
        <Header label="Recording" />
        <Empty
          icon="heroicons-outline:document-text"
          title="No camera on this alarm"
          body="It was raised without a camera event behind it — there is no footage to point at."
        />
      </Frame>
    );
  }

  if (!camera) {
    // NOT the same as "no footage": the recorder that owns this camera is not
    // answering, or no longer federated. Saying "nothing recorded" here would
    // send an operator looking for a fault in the wrong place.
    return (
      <Frame>
        <Header label="Recording" right={cameraId} />
        <Empty
          icon="heroicons-outline:signal-slash"
          title="Camera not reachable from here"
          body="The alarm names a camera this console cannot resolve — check the recorder is federated and online."
        />
      </Frame>
    );
  }

  if (!Number.isFinite(eventMs)) {
    return (
      <Frame>
        <Header label="Recording" right={camera.name} />
        <Empty
          icon="heroicons-outline:clock"
          title="No moment to play"
          body="This alarm carries no event time, so there is no instant to open the recording at."
        />
      </Frame>
    );
  }

  return (
    <Frame>
      <Header label="Recording" right={camera.name} />
      <div className="relative min-h-0 w-full flex-1 bg-black">
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
      </div>
    </Frame>
  );
}
