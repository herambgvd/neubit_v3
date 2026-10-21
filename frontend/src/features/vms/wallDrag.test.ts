/**
 * A DROP ON A WALL TILE, FROM WHEREVER IT CAME (SCRUM-336).
 *
 * With a live view on each monitor of a station, a drag can come from another
 * window. The browser carried it — as a bare tile index, which the receiving wall
 * took for one of its OWN tiles and swapped two unrelated cells. A tile drag now
 * carries its camera and the mark of the window it left: only this window's tiles
 * rearrange, anyone else's land as a camera.
 */
import { describe, expect, it } from "vitest";

import {
  CAMERA_ID_TYPE,
  CAMERA_IDS_TYPE,
  OWN_WALL_TYPE,
  TILE_INDEX_TYPE,
  dragEffect,
  readDrop,
  startTileDrag,
} from "./wallDrag";

/** A drag as a target sees it: the types, and the data at drop time. */
function drag(data: Record<string, string>) {
  return { types: Object.keys(data), getData: (t: string) => data[t] ?? "" };
}

/** What a tile of THIS window puts on a drag. */
function ownTile(index: number, cameraId: string) {
  const data: Record<string, string> = {};
  const dt = {
    setData: (t: string, v: string) => {
      data[t] = v;
    },
    effectAllowed: "none",
  } as unknown as DataTransfer;
  startTileDrag(dt, index, cameraId);
  return { data, effectAllowed: dt.effectAllowed };
}

/** The same tile, arriving in another window: its mark is not this window's. */
function foreignTile(index: number, cameraId: string) {
  const { data } = ownTile(index, cameraId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k === OWN_WALL_TYPE ? "application/x-neubit-wall-0000aa" : k] = v;
  return out;
}

describe("a tile of this wall", () => {
  it("rearranges: dropped on another tile it swaps with it", () => {
    expect(readDrop(drag(ownTile(3, "cam-a").data), 0)).toEqual({ kind: "swap", from: 3 });
  });

  it("dropped back on itself does nothing", () => {
    expect(readDrop(drag(ownTile(2, "cam-a").data), 2)).toBeNull();
  });

  it("moves, and allows both effects so a copy into another window is not refused", () => {
    const { data, effectAllowed } = ownTile(1, "cam-a");
    expect(dragEffect(Object.keys(data))).toBe("move");
    expect(effectAllowed).toBe("copyMove");
  });
});

describe("a tile dragged in from another window", () => {
  it("lands as its camera, never as a swap of this wall's tiles", () => {
    expect(readDrop(drag(foreignTile(3, "cam-a")), 0)).toEqual({ kind: "one", id: "cam-a" });
  });

  it("copies", () => {
    expect(dragEffect(Object.keys(foreignTile(3, "cam-a")))).toBe("copy");
  });
});

describe("the rail", () => {
  it("puts one camera on the tile", () => {
    expect(readDrop(drag({ [CAMERA_ID_TYPE]: "cam-b" }), 4)).toEqual({ kind: "one", id: "cam-b" });
    expect(dragEffect([CAMERA_ID_TYPE])).toBe("copy");
  });

  it("puts a whole recorder from the tile onward", () => {
    const branch = drag({ [CAMERA_IDS_TYPE]: JSON.stringify(["c1", "c2"]) });
    expect(readDrop(branch, 4)).toEqual({ kind: "many", ids: ["c1", "c2"] });
    expect(dragEffect([CAMERA_IDS_TYPE])).toBe("copy");
  });

  it("does not fail a drop over a malformed branch", () => {
    expect(readDrop(drag({ [CAMERA_IDS_TYPE]: "{not json", [CAMERA_ID_TYPE]: "cam-c" }), 0)).toEqual({
      kind: "one",
      id: "cam-c",
    });
    expect(readDrop(drag({ [CAMERA_IDS_TYPE]: "[]" }), 0)).toBeNull();
  });
});

describe("anything else", () => {
  it("is not taken", () => {
    expect(dragEffect(["text/plain"])).toBeNull();
    expect(readDrop(drag({ "text/plain": "hello" }), 0)).toBeNull();
  });

  it("a bare tile index with no window mark is not a swap here", () => {
    expect(readDrop(drag({ [TILE_INDEX_TYPE]: "3" }), 0)).toBeNull();
    expect(dragEffect([TILE_INDEX_TYPE])).toBeNull();
  });
});

describe("the window mark", () => {
  it("is lowercase, as a drag's types reach the target", () => {
    expect(OWN_WALL_TYPE).toBe(OWN_WALL_TYPE.toLowerCase());
    expect(OWN_WALL_TYPE).toMatch(/^application\/x-neubit-wall-[0-9a-f]{12}$/);
  });
});
