/**
 * Pulse's job is to be believable, and every test here is about the same failure:
 * a value nobody measured being rendered as a value.
 *
 * The recorder marks what it cannot read as `unmeasured`; the roll-up keeps nulls
 * rather than zeroes; this is the last place that can be lost. `pct ?? 0` renders
 * a confident "0% used" for a disk nobody looked at, and a green dot on a stage
 * the recorder does not instrument says "the network is fine" about something
 * that was never checked.
 */
import { describe, expect, it } from "vitest";

import type { PulseOverview } from "../types";
import {
  answeredLabel,
  camerasLabel,
  pctText,
  recordingLabel,
  stageTone,
  verdictTone,
  volumeLabel,
  volumeTone,
} from "./format";

const overview = (over: Partial<PulseOverview> = {}): PulseOverview =>
  ({
    generated_at: "2026-09-09T06:00:00Z",
    partial: false,
    totals: {
      recorders: 2,
      recorders_answered: 2,
      cameras_total: 12,
      cameras_online: 11,
      cameras_recording: 10,
      recording_gap_free: true,
    },
    storage: { worst_used_percent: 61, volumes_measured: 2, volumes_total: 2, retention_days_min: 30 },
    nodes: [],
    unreachable: [],
    offline_cameras: [],
    attention: [],
    ...over,
  }) as PulseOverview;

describe("a reading that does not exist", () => {
  it("is grey, not green", () => {
    // Green would say "measured and fine" about a disk with no readable usage.
    expect(volumeTone(null)).toBe("idle");
    expect(volumeTone(undefined)).toBe("idle");
    expect(volumeTone(10)).toBe("good");
  });

  it("says so instead of printing a number", () => {
    expect(pctText(null)).toBe("not measured");
    expect(pctText(61.4)).toBe("61%");
  });

  it("carries the node's own reason when it gave one", () => {
    expect(volumeLabel({ used_percent: null, usage_error: "s3 pool has no probeable path" } as never))
      .toBe("usage unreadable");
    expect(volumeLabel({ used_percent: null, usage_error: null } as never)).toBe("not measured");
    expect(volumeLabel({ used_percent: 88.6, usage_error: null } as never)).toBe("89% used");
  });
});

describe("storage bands", () => {
  it("warn at 85 and critical at 95, matching the backend's own thresholds", () => {
    expect(volumeTone(84.9)).toBe("good");
    expect(volumeTone(85)).toBe("warn");
    expect(volumeTone(94.9)).toBe("warn");
    expect(volumeTone(95)).toBe("bad");
  });
});

describe("the recording answer", () => {
  it("does not call a recorder that is recording nothing gap-free", () => {
    // The dangerous one: "gap-free" on a box writing no footage at all is a
    // clean bill of health for something nobody is doing.
    expect(recordingLabel(null, 0)).toEqual({ text: "nothing recording", tone: "idle" });
  });

  it("says 'not confirmed' when cameras are recording but nothing measured it", () => {
    expect(recordingLabel(null, 4)).toEqual({ text: "not confirmed", tone: "idle" });
  });

  it("is loud about a real gap and plain about a real pass", () => {
    expect(recordingLabel(false, 4)).toEqual({ text: "gaps detected", tone: "bad" });
    expect(recordingLabel(true, 4)).toEqual({ text: "4 recording, gap-free", tone: "good" });
  });
});

describe("a partial estate", () => {
  it("marks the camera figure as covering only what answered", () => {
    expect(camerasLabel(overview()).qualified).toBe(false);
    expect(camerasLabel(overview({ partial: true })).qualified).toBe(true);
  });

  it("says how many recorders the numbers actually cover", () => {
    expect(answeredLabel(overview())).toBeNull();
    const said = answeredLabel(
      overview({ partial: true, totals: { ...overview().totals, recorders_answered: 3, recorders: 4 } }),
    );
    expect(said).toMatch(/3 of 4 recorders answered/);
  });
});

describe("verdict and stage tones", () => {
  it("maps the recorder's own words", () => {
    expect(verdictTone("ok")).toBe("good");
    expect(verdictTone("degraded")).toBe("warn");
    expect(verdictTone("down")).toBe("bad");
  });

  it("treats a level it has never seen as unknown, not healthy", () => {
    expect(verdictTone("spectacular")).toBe("idle");
    expect(verdictTone(null)).toBe("idle");
  });

  it("never paints an uninstrumented stage as a pass", () => {
    // The recorder says it does not measure decode errors or display fps. Green
    // there would claim a check that never happened.
    expect(stageTone("ok", false)).toBe("idle");
    expect(stageTone("ok", true)).toBe("good");
    expect(stageTone("bad", true)).toBe("bad");
  });
});
