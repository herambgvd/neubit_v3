// Shared shapes for the Patterns console (Patterns.tsx + PatternListRow +
// PatternDetail): the master list mixes patterns and camera groups, so its rows
// and callbacks carry the union and narrow with `isPatternItem`.
import type { CameraGroupPublic, PatternPublic } from "../types";

/** One row of the Patterns | Camera Groups list. */
export type PatternItem = PatternPublic | CameraGroupPublic;

/** A pattern carries `camera_group_ids`; a camera group never does. */
export const isPatternItem = (item: PatternItem): item is PatternPublic => "camera_group_ids" in item;
