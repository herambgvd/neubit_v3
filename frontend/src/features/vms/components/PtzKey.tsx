"use client";

// PtzKey — the key a live picture offers to open its PTZ panel (SCRUM-331, SCRUM-332).
// Every VMS engages PTZ from the video and on demand, so the wall tile and the
// Cameras page carry this one key in the player's control bar. It shows pressed
// while that picture's panel is open, and the panel has a close key of its own.
import { DARK_STATUSES } from "../constants";
import { PlayerBtn } from "./LivePlayer";

/** Offered for a head the operator may drive, on a live picture (a recording
 *  cannot be steered) of a camera that is not dark (nothing would answer). */
export function ptzKeyOffered(available: boolean, status: string | null | undefined, playback = false): boolean {
  return available && !playback && !DARK_STATUSES.has(status || "unknown");
}

export default function PtzKey({ open, onToggle }: Readonly<{ open: boolean; onToggle: () => void }>) {
  return (
    <PlayerBtn
      icon="heroicons-outline:viewfinder-circle"
      title={open ? "Close PTZ control" : "PTZ control — move, zoom and presets"}
      active={open}
      onClick={onToggle}
    />
  );
}
