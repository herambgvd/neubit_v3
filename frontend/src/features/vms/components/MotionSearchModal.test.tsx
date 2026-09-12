// Drawing a motion-search region from the keyboard.
//
// The region is what the forensic search is scoped to, and dragging it is the
// only gesture the modal ever had — so this is the whole of that control for
// anybody without a mouse. The rules it has to keep: every key that takes focus
// does something, a rectangle never leaves the frame or collapses to nothing,
// and a key the surface does not claim is LEFT ALONE so Tab still escapes.
import { describe, expect, it } from "vitest";

import { regionKeyAction } from "./MotionSearchModal";

const seed = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const draft = (region: typeof seed | null = seed) => ({ region });

/** The rectangle an action produced — the test fails loudly if it produced none. */
function drafted(action: ReturnType<typeof regionKeyAction>) {
  expect(action?.kind).toBe("draft");
  return (action as { kind: "draft"; region: typeof seed }).region;
}

describe("regionKeyAction", () => {
  it("seeds a visible region on the first press, whichever key it is", () => {
    for (const key of ["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      // Nothing drawn yet: the surface has focus, so the press must produce a
      // region rather than nothing at all.
      expect(drafted(regionKeyAction(key, draft(null)))).toEqual(seed);
    }
  });

  it("moves the region by a step without changing its size", () => {
    const right = drafted(regionKeyAction("ArrowRight", draft()));
    expect(right.x).toBeCloseTo(0.3);
    expect(right.y).toBe(seed.y);
    expect(right.w).toBe(seed.w);
    expect(right.h).toBe(seed.h);

    const up = drafted(regionKeyAction("ArrowUp", draft()));
    expect(up.y).toBeCloseTo(0.2);
    expect(up.x).toBe(seed.x);
  });

  it("resizes instead of moving when Shift is held", () => {
    const wider = drafted(regionKeyAction("ArrowRight", { shiftKey: true, region: seed }));
    expect(wider.w).toBeCloseTo(0.55);
    expect(wider.x).toBe(seed.x);

    const shorter = drafted(regionKeyAction("ArrowUp", { shiftKey: true, region: seed }));
    expect(shorter.h).toBeCloseTo(0.45);
    expect(shorter.y).toBe(seed.y);
  });

  it("keeps the region inside the frame instead of walking it off the edge", () => {
    const atRight = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    expect(drafted(regionKeyAction("ArrowRight", draft(atRight))).x).toBeCloseTo(0.5);
    expect(drafted(regionKeyAction("ArrowDown", draft(atRight))).y).toBeCloseTo(0.5);

    const atOrigin = { x: 0, y: 0, w: 0.2, h: 0.2 };
    expect(drafted(regionKeyAction("ArrowLeft", draft(atOrigin))).x).toBe(0);
    expect(drafted(regionKeyAction("ArrowUp", draft(atOrigin))).y).toBe(0);
  });

  it("never resizes a region past the frame or down to nothing", () => {
    const wide = { x: 0.4, y: 0.4, w: 0.6, h: 0.6 };
    expect(drafted(regionKeyAction("ArrowRight", { shiftKey: true, region: wide })).w).toBeCloseTo(0.6);
    expect(drafted(regionKeyAction("ArrowDown", { shiftKey: true, region: wide })).h).toBeCloseTo(0.6);

    // A region shrunk to nothing would be discarded by the commit path as an
    // accidental click, so the floor has to stay above that threshold.
    const tiny = { x: 0.1, y: 0.1, w: 0.05, h: 0.05 };
    expect(drafted(regionKeyAction("ArrowLeft", { shiftKey: true, region: tiny })).w).toBeCloseTo(0.05);
    expect(drafted(regionKeyAction("ArrowUp", { shiftKey: true, region: tiny })).h).toBeCloseTo(0.05);
  });

  it("keeps a drawn region on Enter and throws one away on Escape", () => {
    expect(regionKeyAction("Enter", draft())).toEqual({ kind: "commit" });
    expect(regionKeyAction(" ", draft())).toEqual({ kind: "commit" });
    expect(regionKeyAction("Escape", draft())).toEqual({ kind: "discard" });
    // Escape with NOTHING drawn is not claimed. This dialog closes on Escape from
    // a document-level listener, and the committed regions have their own Clear
    // button — so a press here that cleared them would also shut the dialog, and
    // the operator would never see what it did.
    expect(regionKeyAction("Escape", draft(null))).toBeNull();
  });

  it("does not claim keys that are not region edits", () => {
    // null is what tells the handler to skip preventDefault. Claiming Tab here
    // would trap focus on the frame with no way out but a mouse.
    for (const key of ["Tab", "a", "PageUp", "PageDown", "Home", "End"]) {
      expect(regionKeyAction(key, draft())).toBeNull();
      expect(regionKeyAction(key, draft(null))).toBeNull();
    }
  });
});
