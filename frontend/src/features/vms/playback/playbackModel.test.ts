import { describe, expect, it } from "vitest";
import {
  HOUR_MS,
  MAX_SPAN_MS,
  MIN_SPAN_MS,
  MINUTE_MS,
  clampSpeed,
  dayWindow,
  defaultStart,
  durationText,
  followPage,
  gridDims,
  keyAction,
  layoutFor,
  localDay,
  maxSpeedFor,
  monthRange,
  nearestZoom,
  nextEvent,
  nextRecording,
  prevEvent,
  prevRecording,
  queryWindow,
  spansFromRanges,
  speedText,
  stepSpeed,
  stepZoom,
  ticksFor,
  triggerKey,
  unionSpans,
  windowAt,
  zoomWindow,
} from "./playbackModel";

const T0 = new Date(2026, 9, 6, 10, 0, 0).getTime(); // local 2026-10-06 10:00

describe("timeline window", () => {
  it("zooms around the cursor, keeping that instant under the same pixel", () => {
    const win = { fromMs: T0, toMs: T0 + HOUR_MS };
    const at = T0 + 15 * MINUTE_MS; // a quarter of the way in
    const z = zoomWindow(win, 0.5, at);
    expect(z.toMs - z.fromMs).toBe(30 * MINUTE_MS);
    expect((at - z.fromMs) / (z.toMs - z.fromMs)).toBeCloseTo(0.25);
  });

  it("clamps zoom to 30 s and 7 days", () => {
    const win = windowAt(T0, 60);
    expect(zoomWindow(win, 0.01).toMs - zoomWindow(win, 0.01).fromMs).toBe(MIN_SPAN_MS);
    const wide = zoomWindow(windowAt(T0, 86_400), 100);
    expect(wide.toMs - wide.fromMs).toBe(MAX_SPAN_MS);
  });

  it("steps along the ladder and names the nearest rung", () => {
    const hour = windowAt(T0, 3_600);
    expect(stepZoom(hour, 1)).toBe(21_600);
    expect(stepZoom(hour, -1)).toBe(900);
    expect(nearestZoom(windowAt(T0, 3_500)).label).toBe("1h");
  });

  it("turns the page only when the playhead leaves the window", () => {
    const win = { fromMs: T0, toMs: T0 + HOUR_MS };
    expect(followPage(win, T0 + 30 * MINUTE_MS)).toBe(win);
    const next = followPage(win, T0 + HOUR_MS + MINUTE_MS);
    expect(next.toMs - next.fromMs).toBe(HOUR_MS);
    expect(next.fromMs).toBeLessThan(T0 + HOUR_MS + MINUTE_MS);
    expect(next.toMs).toBeGreaterThan(T0 + HOUR_MS + MINUTE_MS);
  });

  it("a day window runs local midnight to local midnight", () => {
    const d = dayWindow(T0);
    expect(new Date(d.fromMs).getHours()).toBe(0);
    expect(localDay(d.fromMs)).toBe("2026-10-06");
    expect(localDay(d.toMs)).toBe("2026-10-07");
  });

  it("rounds query windows out to a grain so a drag does not refetch per pixel", () => {
    const q = queryWindow({ fromMs: T0 + 61_000, toMs: T0 + 20 * MINUTE_MS + 1 });
    expect(q.fromMs).toBe(T0);
    expect(q.toMs).toBe(T0 + 25 * MINUTE_MS);
  });
});

describe("ticks", () => {
  it("spaces ticks at least minPx apart and aligns them to local clock time", () => {
    const ticks = ticksFor({ fromMs: T0 + 7 * MINUTE_MS, toMs: T0 + HOUR_MS }, 800, 80);
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) expect(new Date(t.t).getSeconds()).toBe(0);
    expect(ticks[0].label).toMatch(/^\d\d:\d\d$/);
  });

  it("labels a local midnight with its date", () => {
    const ticks = ticksFor(windowAt(new Date(2026, 9, 7, 0, 0, 0).getTime(), 86_400), 1200);
    const major = ticks.find((t) => t.major);
    expect(major).toBeDefined();
    expect(major!.label).not.toMatch(/:/);
  });

  it("shows seconds at a 30 s zoom", () => {
    expect(ticksFor(windowAt(T0, 30), 900)[0].label).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("layouts and speed", () => {
  it("picks the smallest split that shows every tile", () => {
    expect(layoutFor(1)).toBe(1);
    expect(layoutFor(2)).toBe(4);
    expect(layoutFor(5)).toBe(9);
    expect(layoutFor(16)).toBe(16);
    expect(gridDims(9)).toEqual({ cols: 3, rows: 3 });
  });

  it("caps the speed by how many tiles decode at once", () => {
    expect(maxSpeedFor(1)).toBe(16);
    expect(maxSpeedFor(4)).toBe(8);
    expect(maxSpeedFor(9)).toBe(4);
    expect(clampSpeed(16, 4)).toBe(8);
    expect(clampSpeed(-16, 4)).toBe(-8);
    // Reverse re-opens every tile per step: a big grid plays forward instead.
    expect(clampSpeed(-2, 9)).toBe(1);
  });

  it("steps through slow motion, forward and reverse", () => {
    expect(stepSpeed(1, 1, 1)).toBe(2);
    expect(stepSpeed(1, -1, 1)).toBe(0.5);
    expect(stepSpeed(0.25, -1, 1)).toBe(-1);
    expect(stepSpeed(-1, -1, 1)).toBe(-2);
    expect(stepSpeed(16, 1, 1)).toBe(16);
    expect(stepSpeed(4, 1, 9)).toBe(4);
    expect(stepSpeed(0.25, -1, 9)).toBe(0.25);
  });

  it("writes speeds the way a transport shows them", () => {
    expect(speedText(0.25)).toBe("1/4×");
    expect(speedText(2)).toBe("2×");
    expect(speedText(-4)).toBe("−4×");
  });
});

describe("coverage and jumps", () => {
  const ranges = [
    { start: new Date(T0).toISOString(), duration: 600, trigger_type: "continuous" },
    { start: new Date(T0 + 20 * MINUTE_MS).toISOString(), duration: 60, trigger_type: "motion" },
    { start: null, duration: 5 },
    { start: new Date(T0 + 40 * MINUTE_MS).toISOString(), duration: 30, trigger_type: "event" },
  ];
  const spans = spansFromRanges(ranges);

  it("reads the recorder's ranges into coloured spans and skips broken rows", () => {
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.trigger)).toEqual(["continuous", "motion", "alarm"]);
    expect(spans[0].e - spans[0].s).toBe(600_000);
    expect(triggerKey("schedule")).toBe("continuous");
    expect(triggerKey("manual")).toBe("manual");
  });

  it("fuses overlapping spans across cameras", () => {
    const u = unionSpans([
      [{ s: 0, e: 10_000, trigger: "continuous" }],
      [{ s: 5_000, e: 20_000, trigger: "motion" }, { s: 60_000, e: 70_000, trigger: "motion" }],
    ]);
    expect(u).toEqual([{ s: 0, e: 20_000 }, { s: 60_000, e: 70_000 }]);
  });

  it("jumps to the next and previous recording like a media player", () => {
    expect(nextRecording(spans, T0 + MINUTE_MS)).toBe(T0 + 20 * MINUTE_MS);
    expect(nextRecording(spans, T0 + 45 * MINUTE_MS)).toBeNull();
    // Well inside a recording → back to its start; at its start → the one before.
    expect(prevRecording(spans, T0 + 25 * MINUTE_MS)).toBe(T0 + 20 * MINUTE_MS);
    expect(prevRecording(spans, T0 + 20 * MINUTE_MS + 1_000)).toBe(T0);
  });

  it("jumps between events", () => {
    const times = [T0 + MINUTE_MS, T0 + 5 * MINUTE_MS, T0 + 9 * MINUTE_MS];
    expect(nextEvent(times, T0 + 2 * MINUTE_MS)).toBe(T0 + 5 * MINUTE_MS);
    expect(prevEvent(times, T0 + 5 * MINUTE_MS)).toBe(T0 + MINUTE_MS);
    expect(nextEvent(times, T0 + 10 * MINUTE_MS)).toBeNull();
  });

  it("starts at the first recording inside the window", () => {
    expect(defaultStart(spans, { fromMs: T0 + 15 * MINUTE_MS, toMs: T0 + HOUR_MS })).toBe(T0 + 20 * MINUTE_MS);
    expect(defaultStart([], { fromMs: T0, toMs: T0 + HOUR_MS })).toBe(T0);
  });
});

describe("text", () => {
  it("formats durations and month ranges", () => {
    expect(durationText(65_000)).toBe("1:05");
    expect(durationText(3_725_000)).toBe("1:02:05");
    expect(monthRange(2026, 1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("keys", () => {
  it("maps the keys the clients share", () => {
    expect(keyAction(" ")).toBe("play");
    expect(keyAction("ArrowLeft")).toBe("back5");
    expect(keyAction("ArrowRight", { shift: true })).toBe("fwd60");
    expect(keyAction("ArrowLeft", { alt: true, shift: true })).toBe("prevEvent");
    expect(keyAction("[")).toBe("markIn");
    expect(keyAction("=")).toBe("zoomIn");
    expect(keyAction("End")).toBe("liveEdge");
    expect(keyAction("q")).toBeNull();
  });
});
