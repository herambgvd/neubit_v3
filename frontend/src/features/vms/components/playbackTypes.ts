// Console-side shapes shared by the recorded-playback stack (PlaybackPlayer,
// ScrubBar, UnifiedPlayback, ExportDialog, the bookmark / evidence / motion
// modals). Wire types live in ../types; these are the seams BETWEEN the playback
// components — what a tile hands a dialog, what a timeline override returns.
import type { MotionHit, TimelineMarker } from "../types";

/** One recorded span the ScrubBar paints. vision's `TimelineSegment`, an NVR
 *  range and a federated range all fold into this; every consumer guards on
 *  `start`, so a range the recorder returned without one is simply skipped. */
export interface CoverageSpan {
  start?: string | null;
  end?: string | null;
  trigger_type?: string | null;
}

/** What a `timelineFn` override hands PlaybackPlayer instead of `/timeline`
 *  (NVR footage and federated tiles compute coverage client-side). */
export interface TimelineLike {
  coverage: CoverageSpan[];
  markers?: TimelineMarker[];
}

export type TimelineFn = (opts: { day: string }) => TimelineLike | Promise<TimelineLike>;

/** A `[from, to]` ISO window a player asks to export. */
export interface ExportRange {
  from: string;
  to: string;
}

/** The export the Playback page raises from a tile: the window, and WHICH RECORDER
 *  holds the footage.
 *
 *  `nodeId` is not optional. An export is produced by the recorder that owns the
 *  segments — it reads them off its own disk and signs a chain-of-custody manifest
 *  with its own key — so there is no export to raise without naming one. `cameraId`
 *  is the camera's id ON that recorder, not a federated composite. */
export interface ExportRequest extends ExportRange {
  nodeId: string;
  cameraId: string;
  cameraName?: string | null;
}

/** A seed for the bookmark / evidence-lock modals: an instant, or a span. */
export interface IsoSeed {
  start: string;
  end?: string | null;
}

/** What the motion-search modal hands back on `done` (and `hits: []` to clear). */
export interface MotionSearchResults {
  hits: MotionHit[];
  jobId: string | null;
  note: string;
}
