/**
 * PAINTING A WEEK — the gesture, not the pixels.
 *
 * One drag has to both draw and erase, because the alternative is a rubber tool an
 * operator has to go and find every time they overshoot by an hour. The rule is
 * that the cell a drag STARTS on decides: begin on an empty hour and the stroke
 * paints, begin on one that already holds the tool and the stroke clears.
 *
 * The value is fixed at the start and not recomputed per cell. That is the whole
 * of the second test, and it is not a detail: recomputing would flip the moment
 * the pointer crossed an hour that already held the tool, so a single sweep would
 * come out striped.
 */
import { describe, expect, it } from "vitest";

import { applyStroke, cellsBetween, strokeValue } from "./WeekPainter";
import { emptyWeek } from "./weekSchedule";

describe("what a stroke writes", () => {
  it("paints the tool onto an hour that does not have it", () => {
    expect(strokeValue("off", "record")).toBe("record");
    expect(strokeValue("motion", "record")).toBe("record");
  });

  it("erases when the stroke begins on an hour that already holds the tool", () => {
    expect(strokeValue("record", "record")).toBe("off");
    expect(strokeValue("motion", "motion")).toBe("off");
  });
});

describe("what a drag covers", () => {
  it("fills the rectangle between the two cells, not a path through them", () => {
    // Mon 09:00 → Wed 11:00 is three days by three hours. A snake through the
    // hours would wrap Monday's evening and Tuesday's night into a drag that
    // plainly described a block.
    const cells = cellsBetween([0, 9], [2, 11]);
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual([1, 10]);
    expect(cells).not.toContainEqual([0, 20]);
  });

  it("works dragged backwards, in either axis", () => {
    expect(cellsBetween([2, 11], [0, 9])).toEqual(cellsBetween([0, 9], [2, 11]));
    expect(cellsBetween([0, 11], [2, 9])).toEqual(cellsBetween([0, 9], [2, 11]));
  });

  it("is a single cell for a click", () => {
    expect(cellsBetween([3, 4], [3, 4])).toEqual([[3, 4]]);
  });
});

describe("applying a stroke", () => {
  it("does not mutate the week it was given", () => {
    // The screen keeps the stored week beside the draft to know whether anything
    // changed; mutating in place would make them the same object and "Discard"
    // would have nothing to go back to.
    const before = emptyWeek();
    const after = applyStroke(before, [[0, 9]], "record");
    expect(before[0][9]).toBe("off");
    expect(after[0][9]).toBe("record");
  });

  it("writes one value across every cell in the stroke", () => {
    const week = applyStroke(emptyWeek(), cellsBetween([0, 9], [1, 10]), "motion");
    expect(week[0][9]).toBe("motion");
    expect(week[1][10]).toBe("motion");
    expect(week[2][9]).toBe("off");
  });
});
