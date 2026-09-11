// THE WEEK, BOTH WAYS.
//
// A recording schedule is the RECORDER's document, and it accepts two shapes that
// predate this console:
//
//   A. WEEKLY GRID   {"Mon": [ …24 slot words… ], …} — one word per hour.
//   B. DAY WINDOWS   {"monday": [{"start":"09:00","end":"18:00"}], …}, with an
//      optional "everyday" fallback.
//
// The painter writes shape A: it is the only one that can say "motion only from
// 22:00, continuous from 09:00" hour by hour. It READS both, because a schedule
// written by a sibling console — or by the recorder's own screen — has to draw
// correctly here or the operator is editing something they cannot see.
//
// THE RULE THAT MATTERS: a document this cannot read returns null, never an empty
// week. An empty week is a specific, alarming claim — "this camera records
// nothing" — and making it about a schedule we simply failed to parse is how a
// console tells somebody they are uncovered when they are not. The screen says it
// cannot draw it and points at the recorder.
import type { ScheduleDocument } from "../types";

export type Slot = "off" | "record" | "motion";

/** Monday first: the operator's week starts where the working week does, and the
 *  recorder's own day keys are order-free. */
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** Sunday-first, matching Go's time.Weekday — only used to read "monday" style
 *  keys back onto our Monday-first rows. */
const FULL = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export type Week = Slot[][]; // 7 rows (Mon…Sun) × 24 hours

export function emptyWeek(): Week {
  return DAYS.map(() => Array<Slot>(24).fill("off"));
}

/** Our row index for a day key, or -1. Accepts "Mon", "monday", " MONDAY " — every
 *  spelling the recorder's own parser accepts, or a document it considers valid
 *  would fail to draw here. */
export function rowOf(key: string): number {
  const k = key.trim().toLowerCase();
  const i = FULL.findIndex((f) => f === k || f.slice(0, 3) === k);
  if (i < 0) return -1;
  // Go's Sunday=0 → our Monday=0.
  return (i + 6) % 7;
}

/** The slot vocabularies in use across the sibling editors, mapped onto the three
 *  meanings the recorder understands. An unknown word is OFF, matching the node's
 *  normaliseSlot — inventing recording from a word nobody defined is the
 *  fabrication both sides exist to refuse. */
export function slotOf(v: unknown): Slot {
  switch (String(v ?? "").trim().toLowerCase()) {
    case "continuous":
    case "record":
    case "recording":
    case "on":
    case "always":
      return "record";
    case "motion":
    case "motion_only":
    case "event":
      return "motion";
    default:
      return "off";
  }
}

/** "HH:MM" → minutes since midnight, or null. */
export function hhmm(v: unknown): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return h * 60 + min;
}

/** Shape A. Every day row must be 24 entries or the whole document is rejected —
 *  a HALF-read grid would draw the wrong hours confidently, which is worse than
 *  drawing nothing. Mirrors the recorder's parseGrid. */
function fromGrid(doc: ScheduleDocument): Week | null {
  const week = emptyWeek();
  let seen = 0;
  for (const [key, val] of Object.entries(doc)) {
    const row = rowOf(key);
    if (row < 0 || !Array.isArray(val) || val.length !== 24) return null;
    week[row] = val.map(slotOf);
    seen += 1;
  }
  return seen ? week : null;
}

/** Shape B. A window whose end is at or before its start WRAPS, and both halves
 *  belong to the SAME row — that is what the recorder's evalWindows does (it tests
 *  `nowMin >= start` and `nowMin < end` against the day's own rules), so drawing
 *  the tail on the next row would disagree with the machine that runs it. */
function fromWindows(doc: ScheduleDocument): Week | null {
  const week = emptyWeek();
  let seen = 0;
  for (const [key, val] of Object.entries(doc)) {
    const k = key.trim().toLowerCase();
    const row = rowOf(k);
    if (row < 0 && k !== "everyday") return null;
    if (!Array.isArray(val)) return null;
    const rows = row < 0 ? week.map((_, i) => i) : [row];
    for (const w of val) {
      const start = hhmm((w as { start?: unknown })?.start);
      const end = hhmm((w as { end?: unknown })?.end);
      if (start === null || end === null) return null;
      for (const r of rows) paint(week[r], start, end);
    }
    seen += 1;
  }
  return seen ? week : null;
}

function paint(row: Slot[], startMin: number, endMin: number): void {
  // Hour granularity: an hour is on if the window covers any of it, so 09:30–18:00
  // shows 09:00 lit. Rounding the other way would hide half an hour of footage the
  // recorder is actually keeping.
  const from = Math.floor(startMin / 60);
  const to = Math.ceil(endMin / 60);
  if (startMin < endMin) {
    for (let h = from; h < Math.min(to, 24); h++) row[h] = "record";
    return;
  }
  for (let h = from; h < 24; h++) row[h] = "record";
  for (let h = 0; h < Math.min(to, 24); h++) row[h] = "record";
}

/** Read a recorder's document into a paintable week, or null when it is neither
 *  shape. Null is a real answer and the caller must say so rather than drawing an
 *  empty week. */
export function docToWeek(doc: ScheduleDocument | null | undefined): Week | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (!Object.keys(doc).length) return null;
  return fromGrid(doc) ?? fromWindows(doc);
}

/** Write the painter's week as shape A. Every day is emitted, including the ones
 *  that are entirely off: a day the recorder does not find is OFF anyway, but
 *  writing it makes the document say what the operator saw rather than leaving the
 *  reader to infer it. */
export function weekToDoc(week: Week): ScheduleDocument {
  const out: Record<string, Slot[]> = {};
  DAYS.forEach((d, i) => {
    out[d] = week[i].slice();
  });
  return out;
}

/** Hours covered in the week — the one number that says whether a schedule does
 *  anything at all. Motion counts: it is still a plan to record. */
export function coveredHours(week: Week): number {
  return week.reduce((n, row) => n + row.filter((s) => s !== "off").length, 0);
}

/** A document with no recording in it. The recorder REFUSES an empty document, and
 *  a week painted entirely off is the same intention arriving in a shape it does
 *  accept — so the screen has to catch it here and say what it means. */
export function isAllOff(week: Week): boolean {
  return coveredHours(week) === 0;
}
