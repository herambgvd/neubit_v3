/**
 * Scrubbing the wall's playout track. The track draws a window that is mostly
 * GAP on a motion-recorded estate, so where a click lands is the whole of the
 * control: an operator drags roughly to "about nine this morning" and expects
 * footage, not silence and not a jump backwards into yesterday.
 */
import { describe, expect, it } from "vitest";

import { seekTargetMs } from "./PlayoutBar";

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
