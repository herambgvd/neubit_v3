"use client";

// THE PICTURE ON THE ALARM POP-UP (SCRUM-327).
//
// HikCentral's alarm window and DSS's alarm pop-up both lead with a picture: the
// captured image, or the linked camera's live view. An operator decides most alarms
// on sight — a person at the fence, or a cat — and a pop-up of words alone sends
// every one of them to the Events page to find out.
//
//   * A PLATE READ shows the scene the camera captured at the read — a still the
//     recorder kept, there at once, no stream to open.
//   * ANY OTHER ALARM shows its camera LIVE, on the sub stream, labelled so: the
//     recorder keeps no still of a past instant, and "is it still happening" is
//     the question a live picture answers. The recording at the alarm is one click
//     away in the Events panes.
//
// Only the alarm in front has a picture; paging to another one swaps it.
import type { ReactNode } from "react";
import { Icon } from "@iconify/react";

import { vms } from "../api";
import { anprOf, anprSceneStill, type AnprOfEvent } from "../anprLib";
import type { QueuedAlarm } from "../alarmQueue";
import type { EstateCamera } from "../types";
import { AuthedImage, useAnprRead } from "./AnprEvidence";
import LivePlayer from "./LivePlayer";
import { nodeAddress, useNodeLiveSource } from "../hooks/useNodeLiveSource";

/** A 16:9 box. The still says when it was taken; the live player carries its own
 *  LIVE badge. */
function Frame({ label, children }: Readonly<{ label?: string; children: ReactNode }>) {
  return (
    <div className="relative aspect-video w-full overflow-hidden bg-black">
      {children}
      {label && (
        <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white/90">
          {label}
        </span>
      )}
    </div>
  );
}

function PlateScene({ anpr }: Readonly<{ anpr: AnprOfEvent }>) {
  const q = useAnprRead(anpr);
  const still = q.data ? anprSceneStill(q.data.images) : null;
  if (still) {
    return (
      <Frame label="At the read">
        <AuthedImage path={vms.federation.anpr.imageUrl(anpr.nodeId, anpr.readId, still)} alt={`The read — ${anpr.plate || "no plate"}`} />
      </Frame>
    );
  }
  if (q.isLoading) return <Frame label="At the read">{null}</Frame>;
  return null;
}

function CameraLive({ camera }: Readonly<{ camera: EstateCamera }>) {
  const source = useNodeLiveSource(camera);
  const at = nodeAddress(camera);
  if (!source || !at) return null;
  if (camera.status && String(camera.status).toLowerCase() !== "online") {
    return (
      <div className="flex items-center gap-2 bg-black/40 px-3 py-2 text-[11px] text-muted">
        <Icon icon="heroicons-outline:video-camera-slash" className="text-sm text-red-400/80" />
        The camera is not streaming right now.
      </div>
    );
  }
  return (
    <Frame>
      <LivePlayer
        key={`${at.nodeId}:${at.realId}`}
        cameraId={camera.id}
        cameraName={camera.name}
        nodeId={at.nodeId}
        source={source}
        profile="sub"
        autoPlay
        muted
        minimal
        fit="contain"
        className="h-full w-full"
      />
    </Frame>
  );
}

export default function AlarmMedia({ alarm }: Readonly<{ alarm: QueuedAlarm }>) {
  const anpr = anprOf(alarm.event);
  if (anpr) return <PlateScene anpr={anpr} />;
  if (alarm.camera) return <CameraLive camera={alarm.camera} />;
  return null;
}
