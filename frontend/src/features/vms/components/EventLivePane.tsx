"use client";

// THE THIRD PANEL — what that camera is showing NOW.
//
// The reference console puts a Snapshot here: the still its detector captured at
// the moment it fired. Our recorder keeps no such still for a past instant, and a
// pane labelled "Snapshot" that quietly showed a frame from some OTHER moment
// would be the worst kind of picture — the one an operator believes.
//
// So this panel answers the question the recording cannot: is it still going on.
// The recording above shows what happened; this shows what is happening. When the
// camera is the thing that broke, it says that, in the recorder's own sentence.
import { useMemo } from "react";
import { Icon } from "@iconify/react";

import { vms } from "../api";
import type { EstateCamera, LiveSessionSource } from "../types";
import LivePlayer from "./LivePlayer";

export interface EventLivePaneProps {
  camera: EstateCamera | null;
}

export default function EventLivePane({ camera }: EventLivePaneProps) {
  const nodeId = (camera as { node_id?: string } | null)?.node_id ?? null;
  const realId = (camera as { real_id?: string } | null)?.real_id ?? null;

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

  // KNOWN to be down, not merely unheard-of: a status that has not arrived is not
  // a camera that is offline.
  const offline = camera?.status ? String(camera.status).toLowerCase() !== "online" : false;

  // NOTHING SELECTED IS NOT A DEAD CAMERA. With no event the pane used to paint
  // its full black video slab and write one grey line in the middle of it — which
  // reads as a camera that has stopped, on the panel whose whole job is to say
  // whether something is still going on. The black frame belongs to a stream;
  // without one there is no frame, only a card saying why.
  const empty = !camera;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex shrink-0 items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon icon="heroicons:signal" className="text-sm text-emerald-400" />
        <span className="text-[12px] font-semibold text-foreground">Live view</span>
        {camera?.name && (
          <span className="ml-auto truncate text-[11px] text-muted">{camera.name}</span>
        )}
      </header>

      {/* min-h-0 + flex-1: the frame takes the height the row gives it and the
          video fits INSIDE, rather than the video's aspect ratio deciding how tall
          the row must be. */}
      <div className={`relative min-h-0 w-full flex-1 ${empty ? "" : "bg-black"}`}>
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Icon icon="heroicons:signal" className="text-3xl text-muted opacity-40" />
            <p className="text-[12.5px] text-foreground">Nothing to watch yet</p>
            <p className="max-w-xs text-[11px] text-muted">
              Pick an event and this pane shows that camera live — whether whatever
              tripped it is still happening.
            </p>
          </div>
        ) : source && !offline ? (
          <LivePlayer
            key={`${nodeId}:${realId}`}
            cameraId={camera.id}
            cameraName={camera.name}
            nodeId={nodeId}
            source={source}
            profile="sub"
            autoPlay
            muted
            fit="contain"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Icon icon="heroicons-outline:video-camera-slash" className="text-2xl text-red-400/70" />
            <p className="text-[12px] text-foreground">
              {offline ? "Not streaming right now" : "No live source for this camera"}
            </p>
            <p className="text-[11px] text-muted">
              The recording beside this still plays what was captured before it went.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
