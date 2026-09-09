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

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-card-border bg-card">
      <header className="flex items-center gap-2 border-b border-card-border px-3 py-2">
        <Icon icon="heroicons:signal" className="text-sm text-emerald-400" />
        <span className="text-[12px] font-semibold text-foreground">Live view</span>
        {camera?.name && (
          <span className="ml-auto truncate text-[11px] text-muted">{camera.name}</span>
        )}
      </header>

      {/* min-h-0 + flex-1: the frame takes the height the row gives it and the
          video fits INSIDE, rather than the video's aspect ratio deciding how tall
          the row must be. */}
      <div className="relative min-h-0 w-full flex-1 bg-black">
        {!camera ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted">
            No camera on this event.
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
