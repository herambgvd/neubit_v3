"use client";

// PatternStage — the wall while a PATTERN is rotating.
//
// The problem it solves: a rotation used to switch groups by rewriting the same
// tiles. Tile 0 kept its React identity while its cameraId changed, so every stop
// meant release the session, mint a new one, renegotiate WHEP, wait for a first
// frame — with the whole wall sitting on "Connecting…" while that happened, in
// front of whoever is watching the control-room screen.
//
// So the stage is DOUBLE-BUFFERED. Two layer slots, each with a stable identity.
// One is on screen; the other mounts the NEXT stop a few seconds early, hidden at
// opacity 0 but genuinely playing. At the dwell boundary the two crossfade and
// swap roles. No player is ever remounted at the moment anyone is looking at it,
// so a switch has no connecting state at all.
//
// The cost is deliberate and bounded: during the overlap window both stops stream.
// The outgoing layer is dropped as soon as the fade finishes (see Streaming.tsx),
// so the wall runs at 1× for most of a dwell and 2× for a few seconds around each
// switch — not 2× continuously.
//
// Tiles here are READ-ONLY: no drag, no swap, no close, no picker. A rotation is
// an unattended sequence; rearranging a tile that is about to be replaced two
// seconds later would only look broken. Manual control returns on exit, when
// `cells` already holds the stop that was on screen.
import { memo, useMemo } from "react";

import WallTile from "./WallTile";
import { getLayout, gridStyle, tileProfile, tileStyle } from "../videoWall";

// Long enough to read as a crossfade rather than a cut, short enough that the
// wall is never ambiguous about which stop it is showing.
export const STAGE_FADE_MS = 500;

// Identity of a stop for buffer bookkeeping — the group AND its cameras, because
// editing a group's cameras must count as a different thing to show.
export function stopKey(stop: any) {
  return stop ? `${stop.groupId}:${(stop.cameraIds || []).join(",")}` : null;
}

function StageLayer({ stop, visible, cameraById, estateReady, qualityProfile }: any) {
  const layout = useMemo(() => getLayout(stop.wallLayout), [stop.wallLayout]);
  // Stable per-tile grid-area objects, same reason as the manual wall: a fresh
  // object each render would defeat WallTile's memo.
  const styles = useMemo(
    () => Array.from({ length: layout.capacity }, (_, i) => tileStyle(layout, i)),
    [layout],
  );

  return (
    <div
      // `opacity`, never `display:none` or `visibility:hidden` — the hidden layer
      // has to keep decoding video, which is the entire point of preloading it.
      className={`absolute inset-0 grid gap-1.5 transition-opacity ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
      style={{ ...gridStyle(layout), transitionDuration: `${STAGE_FADE_MS}ms` }}
      aria-hidden={!visible}
    >
      {Array.from({ length: layout.capacity }, (_, i) => {
        const id = stop.cameraIds?.[i] || null;
        return (
          <WallTile
            key={`tile-${i}`}
            index={i}
            cameraId={id}
            camera={id ? cameraById.get(id) : null}
            profile={qualityProfile || tileProfile(layout.capacity, false)}
            estateReady={estateReady}
            style={styles[i]}
          />
        );
      })}
    </div>
  );
}

const MemoLayer = memo(StageLayer);

function PatternStage({ slots, front, cameraById, estateReady, qualityProfile }: any) {
  return (
    <div className="relative h-full min-h-0">
      {[0, 1].map((slot) =>
        slots[slot] ? (
          // Keyed by SLOT, not by content. That is what makes the buffer work: the
          // layer keeps its identity — and its mounted players — while the content
          // it holds is swapped in ahead of time, off screen.
          <MemoLayer
            key={`stage-slot-${slot}`}
            stop={slots[slot]}
            visible={front === slot}
            cameraById={cameraById}
            estateReady={estateReady}
            qualityProfile={qualityProfile}
          />
        ) : null,
      )}
    </div>
  );
}

export default memo(PatternStage);
