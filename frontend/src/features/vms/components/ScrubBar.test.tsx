// Keyboard seeking on the scrub bar.
//
// This is the only way to move the playhead without a mouse, so it is the whole
// of the control for anybody driving the console from the keyboard. The rules it
// has to keep: a step is relative to what is on screen, the ends clamp rather
// than run past the footage, and a key the slider does not claim is LEFT ALONE —
// swallowing Tab would trap focus inside a video player.
import { describe, expect, it } from "vitest";

import { seekTarget } from "./ScrubBar";

// An hour-long window starting at a round epoch, with the playhead in the middle.
const HOUR = 3_600_000;
const START = 1_700_000_000_000;
const win = { windowStart: START, span: HOUR, current: START + HOUR / 2 };

describe("seekTarget", () => {
  it("nudges by 1% of the visible window, not a fixed number of seconds", () => {
    expect(seekTarget("ArrowRight", win)).toBe(win.current + HOUR / 100);
    expect(seekTarget("ArrowLeft", win)).toBe(win.current - HOUR / 100);

    // The same key on a week-long window moves a week's worth of 1%. A fixed step
    // would be imperceptible here and wild on a one-minute window.
    const week = { windowStart: START, span: HOUR * 168, current: START + HOUR * 84 };
    expect(seekTarget("ArrowRight", week)).toBe(week.current + (HOUR * 168) / 100);
  });

  it("pages by ten times a nudge", () => {
    expect(seekTarget("PageDown", win)! - win.current).toBe(
      (seekTarget("ArrowRight", win)! - win.current) * 10,
    );
    expect(seekTarget("PageUp", win)).toBe(win.current - (HOUR / 100) * 10);
  });

  it("Home and End land exactly on the window's edges", () => {
    expect(seekTarget("Home", win)).toBe(START);
    expect(seekTarget("End", win)).toBe(START + HOUR);
  });

  it("clamps instead of seeking past the footage on screen", () => {
    const atStart = { ...win, current: START };
    const atEnd = { ...win, current: START + HOUR };
    expect(seekTarget("ArrowLeft", atStart)).toBe(START);
    expect(seekTarget("PageUp", atStart)).toBe(START);
    expect(seekTarget("ArrowRight", atEnd)).toBe(START + HOUR);
    expect(seekTarget("PageDown", atEnd)).toBe(START + HOUR);
  });

  it("does not claim keys that are not seeks", () => {
    // null is what tells the handler to skip preventDefault. If any of these
    // returned a number the slider would eat Tab, typing, and every shortcut the
    // screen above it registers.
    for (const key of ["Tab", "Enter", " ", "Escape", "a", "ArrowUp", "ArrowDown"]) {
      expect(seekTarget(key, win)).toBeNull();
    }
  });
});
