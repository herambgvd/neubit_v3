// How Pulse turns an honest payload into honest text.
//
// Every function here has the same job: keep "we did not measure this" from
// becoming a number. The recorder marks what it cannot read as `unmeasured`, the
// roll-up keeps nulls rather than zeroes, and this is the last place that
// discipline can be lost — a `${pct}%` template on a null renders "null%", and a
// `pct ?? 0` renders a confident 0% for a disk nobody looked at.

import type { PulseOverview, PulseVolume } from "../types";

/** Storage bands. Deliberately the same shape as the wall's load chip
 *  (components/HostLoadChip) so one colour means one thing across the console —
 *  but the numbers differ, because a disk is not a CPU: 85% full is worth
 *  attention, 95% is about to start recycling footage. Matches
 *  `rollup.VOLUME_WARN_PCT` / `VOLUME_CRITICAL_PCT` on the backend. */
export const VOLUME_WARN_PCT = 85;
export const VOLUME_CRITICAL_PCT = 95;

export type Tone = "good" | "warn" | "bad" | "idle";

/** The tone one volume reading gets. A reading that does not exist is `idle`
 *  (grey) — never green, which would read as "measured and fine". */
export function volumeTone(pct: number | null | undefined): Tone {
  if (pct == null) return "idle";
  if (pct >= VOLUME_CRITICAL_PCT) return "bad";
  if (pct >= VOLUME_WARN_PCT) return "warn";
  return "good";
}

/** A count the recorder reported — and 0 only when it reported no number.
 *
 *  The System-Monitor board is relayed UNRESHAPED: `pulse/router.py` hands the
 *  recorder's own JSON straight through, so nothing between the box and this
 *  string has checked that `cameras.online` is a number. A recorder on another
 *  schema can put an object there, and `${…}` renders that as "[object Object]"
 *  in the slot an operator reads a camera count out of. A value that is not a
 *  number is not a count. */
export function reportedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A string the recorder reported, or "". Same reasoning as `reportedCount`:
 *  `String(x)` never fails on an unvalidated payload, it just prints the type's
 *  name where the camera's name belongs. */
export function reportedText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A percentage as text, or the reason there isn't one. */
export function pctText(pct: number | null | undefined): string {
  return pct == null ? "not measured" : `${Math.round(pct)}%`;
}

/** What a volume's headline says: its usage, or the node's own error. */
export function volumeLabel(volume: PulseVolume): string {
  if (volume.used_percent != null) return `${Math.round(volume.used_percent)}% used`;
  return volume.usage_error ? "usage unreadable" : "not measured";
}

/** The recording answer, in the operator's words.
 *
 *  Three states, and the third is why this is a function: `null` means nothing is
 *  recording, which is NOT "no gaps". Saying "gap-free" there is a clean bill of
 *  health for footage nobody is writing. */
export function recordingLabel(gapFree: boolean | null | undefined, recording: number): {
  text: string;
  tone: Tone;
} {
  if (gapFree === false) return { text: "gaps detected", tone: "bad" };
  if (gapFree === true) return { text: `${recording} recording, gap-free`, tone: "good" };
  return { text: recording > 0 ? "not confirmed" : "nothing recording", tone: "idle" };
}

/** Cameras online, and whether that number covers the whole estate.
 *
 *  With a recorder unreachable, "109 / 112" is a lie that looks precise: those
 *  112 are the cameras of the recorders that answered. The caller renders the
 *  qualifier; this decides whether there is one. */
export function camerasLabel(o: PulseOverview): { text: string; qualified: boolean } {
  const { cameras_online: online, cameras_total: total } = o.totals;
  return { text: `${online} / ${total}`, qualified: o.partial };
}

/** "3 of 4 recorders answered" — only when one did not. */
export function answeredLabel(o: PulseOverview): string | null {
  if (!o.partial) return null;
  const { recorders_answered: got, recorders: all } = o.totals;
  return `${got} of ${all} recorders answered — the figures below cover those ${got}`;
}

/** A recorder's verdict tone. `down` and `degraded` are the recorder's own
 *  words (nvr sysmon deriveVerdict); anything else it invents later reads idle
 *  rather than green, because an unknown level is not a healthy one. */
export function verdictTone(level: string | null | undefined): Tone {
  const l = (level || "").toLowerCase();
  if (l === "down") return "bad";
  if (l === "degraded") return "warn";
  if (l === "ok") return "good";
  return "idle";
}

/** A fault-trace stage's tone. `measured: false` is grey, never green: the
 *  recorder is telling us it does not instrument that stage, and painting it as
 *  a pass is how "the network is fine" gets said about a thing nobody checked. */
export function stageTone(state: string, measured: boolean): Tone {
  if (!measured) return "idle";
  const s = (state || "").toLowerCase();
  if (s === "bad") return "bad";
  if (s === "warn") return "warn";
  if (s === "ok") return "good";
  return "idle";
}

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-nb-good",
  warn: "text-nb-warn",
  bad: "text-nb-crit",
  idle: "text-nb-faint",
};

export const TONE_BAR: Record<Tone, string> = {
  good: "bg-nb-good",
  warn: "bg-nb-warn",
  bad: "bg-nb-crit",
  idle: "bg-[rgba(150,180,245,.25)]",
};

export const SEVERITY_TONE: Record<string, Tone> = {
  critical: "bad",
  warning: "warn",
  info: "idle",
};
