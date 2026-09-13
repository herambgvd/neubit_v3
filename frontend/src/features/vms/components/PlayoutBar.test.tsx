/**
 * Scrubbing the wall's playout track. The track draws a window that is mostly
 * GAP on a motion-recorded estate, so where a click lands is the whole of the
 * control: an operator drags roughly to "about nine this morning" and expects
 * footage, not silence and not a jump backwards into yesterday.
 */
import { describe, expect, it } from "vitest";

import { neighbourSpanStart, seekTargetMs, spanRect, trackMarker } from "./PlayoutBar";

const SPANS = [
  { start: 1_000, end: 2_000, trigger: null },
  { start: 5_000, end: 6_000, trigger: "motion" },
];

describe("seekTargetMs", () => {
  it("plays exactly where the operator clicked, inside a recorded span", () => {
    expect(seekTargetMs(1_500, SPANS)).toBe(1_500);
    expect(seekTargetMs(1_000, SPANS)).toBe(1_000);
    expect(seekTargetMs(2_000, SPANS)).toBe(2_000);
  });

  it("snaps forward out of a gap, so a rough drag still lands on footage", () => {
    expect(seekTargetMs(3_000, SPANS)).toBe(5_000);
  });

  it("never snaps backwards", () => {
    // Landing after the last span, the honest answer is "there is nothing here"
    // — which the player then says. Jumping back to earlier footage would show
    // the operator a different moment than the one they asked for.
    expect(seekTargetMs(9_000, SPANS)).toBe(9_000);
    expect(seekTargetMs(9_000, [])).toBe(9_000);
  });
});

describe("neighbourSpanStart", () => {
  it("steps to the next span forwards and the previous one backwards", () => {
    expect(neighbourSpanStart(SPANS, 1_500, 1)).toBe(5_000);
    expect(neighbourSpanStart(SPANS, 5_500, -1)).toBe(1_000);
  });

  it("keeps stepping when the playhead is sitting exactly on a span's start", () => {
    // The repeat case, and the one that made the button look dead: landing on
    // 5_000 and pressing forward again must not find 5_000 "after" the playhead.
    expect(neighbourSpanStart(SPANS, 5_000, 1)).toBeNull();
    expect(neighbourSpanStart(SPANS, 1_000, 1)).toBe(5_000);
  });

  it("says so rather than wrapping around when there is nothing that way", () => {
    expect(neighbourSpanStart(SPANS, 9_000, 1)).toBeNull();
    expect(neighbourSpanStart(SPANS, 0, -1)).toBeNull();
    expect(neighbourSpanStart([], 1_000, 1)).toBeNull();
  });
});

describe("spanRect", () => {
  const FROM = 0;
  const WINDOW = 10_000;

  it("places a span as a percentage of the window on screen", () => {
    expect(spanRect({ start: 1_000, end: 2_000, trigger: null }, FROM, WINDOW)).toEqual({
      left: 10,
      width: 10,
    });
  });

  it("clamps a span to the track rather than painting off either end", () => {
    // A span that started before the window and runs past it — an overnight
    // continuous recording seen through a five-minute lens. Unclamped it would
    // paint over the ticks and the playhead outside the track's own box.
    const r = spanRect({ start: -50_000, end: 60_000, trigger: null }, FROM, WINDOW)!;
    expect(r.left).toBe(0);
    expect(r.width).toBe(100);
  });

  it("never lets real footage round away to nothing", () => {
    // Two seconds on a 24h track. Drawn honestly this is 0.002% — invisible, and
    // an invisible span reads as a gap in footage that exists.
    const r = spanRect({ start: 0, end: 2_000, trigger: null }, 0, 86_400_000)!;
    expect(r.width).toBe(0.15);
  });

  it("draws nothing at all for a span wholly outside the window", () => {
    expect(spanRect({ start: 50_000, end: 60_000, trigger: null }, FROM, WINDOW)).toBeNull();
    expect(spanRect({ start: -50_000, end: -40_000, trigger: null }, FROM, WINDOW)).toBeNull();
  });
});

describe("trackMarker", () => {
  const base = { from: 0, windowMs: 10_000, drag: null, hover: null, playback: false, head: null, nowMs: 7_000 };

  it("follows the pointer while a drag is live, not the playhead", () => {
    // Mid-drag the operator is AIMING. Showing the playhead here would mean the
    // marker ignores the gesture until release.
    const m = trackMarker({ ...base, drag: 0.25, playback: true, head: 9_000 });
    expect(m.markerMs).toBe(2_500);
    expect(m.markerFrac).toBe(0.25);
  });

  it("shows the playhead in playback and the live edge otherwise", () => {
    expect(trackMarker({ ...base, playback: true, head: 3_000 }).markerMs).toBe(3_000);
    expect(trackMarker({ ...base }).markerMs).toBe(7_000);
  });

  it("marks nothing when playback has no playhead yet", () => {
    // Not 0, and not the window's start: parking the marker at the left edge
    // would read as "we are playing the oldest footage in view".
    const m = trackMarker({ ...base, playback: true, head: null });
    expect(m.markerMs).toBeNull();
    expect(m.markerFrac).toBeNull();
  });

  it("reads the hover clock off the pointer, independently of the marker", () => {
    expect(trackMarker({ ...base, hover: 0.5 }).hoverMs).toBe(5_000);
    expect(trackMarker({ ...base }).hoverMs).toBeNull();
  });
});
