"use client";

// THE OTHER CAMERAS AT THIS SITE.
//
// An intrusion rarely stays on the camera that reported it. The case page showed
// exactly one view — the one the recorder happened to name — so following whoever
// tripped it meant leaving the alarm for the video wall and finding the site
// again by hand.
//
// These are the cameras placed on the same site's floor plans, live, small. One
// click puts any of them in the case's live pane, so the answer to "where did
// they go" is on the page the operator is already working.
//
// WHY PLACEMENT AND NOT THE RECORDER'S OWN GROUPING: a recorder is a box in a
// rack, and "the other cameras on recorder-a" can be three buildings. What makes
// two cameras neighbours is being in the same place, and the floor plan is where
// somebody said so.
import { Icon } from "@iconify/react";

import LivePlayer from "@/features/vms/components/LivePlayer";
import { nodeLiveSource } from "@/features/vms/hooks/useNodeLiveSource";
import type { EstateCamera } from "@/features/vms/types";

export interface NearbyCamerasProps {
  /** Cameras at the alarm's site, the alarm's own camera included. */
  atSite: EstateCamera[];
  /** The alarm's camera — excluded from the strip, since it is the case's subject. */
  subject: EstateCamera | null;
  /** Which of them is currently in the live pane, if any. */
  activeId?: string | null;
  onPick?: (camera: EstateCamera) => void;
  /** The alarm's site is unknown — a different thing from having no neighbours. */
  unplaced?: boolean;
  siteName?: string | null;
}

/** The neighbours: everything at the site except the camera the alarm is about,
 *  online first — a dark tile is not what an operator wants to click. */
export function neighboursOf(atSite: EstateCamera[], subject: EstateCamera | null): EstateCamera[] {
  return atSite
    .filter((c) => c.id !== subject?.id)
    .sort((a, b) => {
      const on = (c: EstateCamera) => (String(c.status).toLowerCase() === "online" ? 0 : 1);
      return on(a) - on(b) || String(a.name).localeCompare(String(b.name));
    });
}

export default function NearbyCameras({
  atSite,
  subject,
  activeId = null,
  onPick,
  unplaced = false,
  siteName = null,
}: NearbyCamerasProps) {
  const neighbours = neighboursOf(atSite, subject);

  if (unplaced) {
    // Said as the fixable thing it is, rather than as "none".
    return (
      <p className="text-[12.5px] text-muted">
        This camera is not placed on a floor plan, so the console cannot tell which cameras
        are near it. Place it under Configurations → Sites → Floors.
      </p>
    );
  }

  if (neighbours.length === 0) {
    return (
      <p className="text-[12.5px] text-muted">
        No other camera is placed at {siteName || "this site"}.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
      {neighbours.map((c) => {
        const source = nodeLiveSource(c);
        const offline = String(c.status).toLowerCase() !== "online";
        const active = activeId === c.id;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onPick?.(c)}
            title={`Show ${c.name} in the live pane`}
            aria-pressed={active}
            className={`overflow-hidden rounded-lg border text-left transition ${
              active ? "border-blue-500/60 ring-1 ring-blue-500/40" : "border-card-border hover:border-muted"
            }`}
          >
            <span className="relative block aspect-video w-full bg-black">
              {source && !offline ? (
                <LivePlayer
                  key={c.id}
                  cameraId={c.id}
                  cameraName={c.name}
                  nodeId={(c as { node_id?: string }).node_id ?? null}
                  source={source}
                  profile="sub"
                  autoPlay
                  muted
                  minimal
                  fit="cover"
                  className="absolute inset-0 h-full w-full"
                />
              ) : (
                <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
                  <Icon
                    icon="heroicons-outline:video-camera-slash"
                    className="text-lg text-muted opacity-50"
                  />
                  <span className="text-[10.5px] text-muted">
                    {offline ? "Not streaming" : "No live source"}
                  </span>
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5 px-2 py-1">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  offline ? "bg-muted" : "bg-emerald-500"
                }`}
                aria-hidden
              />
              <span className="truncate text-[11.5px] text-foreground">{c.name}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
