// SCRUM-338: a menu on a tile takes the room there is and never runs past the tile.
import { describe, expect, it } from "vitest";

import { DROP_MIN_PX, dropPlacement } from "./dropRoom";

const W = 224;
const WANT = 240;

describe("where a tile's drop-up opens", () => {
  it("above at its full size when the tile has the room", () => {
    expect(dropPlacement({ above: 400, beside: 550, besideWidth: 300 }, W, WANT)).toEqual({
      side: "above",
      maxHeight: 240,
      width: 224,
    });
  });

  it("above, cut to the room over the anchor, while that still holds a list", () => {
    expect(dropPlacement({ above: 180, beside: 330, besideWidth: 300 }, W, WANT)).toEqual({
      side: "above",
      maxHeight: 180,
      width: 224,
    });
  });

  it("beside the anchor when the room above is too little", () => {
    expect(dropPlacement({ above: DROP_MIN_PX - 1, beside: 200, besideWidth: 300 }, W, WANT)).toEqual({
      side: "left",
      maxHeight: 200,
      width: 224,
    });
  });

  it("beside a card on a narrow tile, narrowed to the room there", () => {
    expect(dropPlacement({ above: 20, beside: 170, besideWidth: 190 }, W, WANT)).toEqual({
      side: "left",
      maxHeight: 170,
      width: 190,
    });
  });

  it("above after all when there is no width to open beside", () => {
    expect(dropPlacement({ above: 60, beside: 200, besideWidth: 120 }, W, WANT)).toEqual({
      side: "above",
      maxHeight: 60,
      width: 224,
    });
  });

  it("never shorter than two rows, even over an anchor the tile already clips", () => {
    expect(dropPlacement({ above: -20, beside: 10, besideWidth: 100 }, W, WANT).maxHeight).toBe(48);
  });

  it("above at its full size before anything is laid out", () => {
    expect(dropPlacement(null, W, WANT)).toEqual({ side: "above", maxHeight: 240, width: 224 });
  });
});
