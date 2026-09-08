/**
 * The health page's reading rules.
 *
 * Two of these decide whether the page tells the truth:
 *  - a container with NO healthcheck is not unhealthy (most of the estate
 *    declares one, a few do not, and painting those red makes the page cry wolf);
 *  - `sinceOf` is what a following log viewer sends as its next lower bound, so
 *    drifting by a second either loops the same lines forever or skips them.
 */
import { describe, expect, it } from "vitest";

import { lineTone, needsAttention, serviceState, sinceOf, splitLine, uptime } from "./serviceFormat";

const svc = (over: Partial<{ state: string; health: string | null; running: boolean }> = {}) => ({
  state: "running",
  health: null as string | null,
  running: true,
  ...over,
});

describe("serviceState", () => {
  it("reads a running container with no healthcheck as running, not unhealthy", () => {
    const s = serviceState(svc({ health: null }));
    expect(s.label).toBe("Running");
    expect(s.tone).not.toContain("crit");
    expect(needsAttention(svc({ health: null }))).toBe(false);
  });

  it("flags an unhealthy container even though it is running", () => {
    expect(serviceState(svc({ health: "unhealthy" })).label).toBe("Unhealthy");
    expect(needsAttention(svc({ health: "unhealthy" }))).toBe(true);
  });

  it("separates starting from healthy", () => {
    expect(serviceState(svc({ health: "starting" })).label).toBe("Starting");
    // A container still coming up is not a fault to chase.
    expect(needsAttention(svc({ health: "starting" }))).toBe(false);
  });

  it("calls a stopped container stopped, and one that is dead dead", () => {
    expect(serviceState(svc({ running: false, state: "exited" })).label).toBe("Stopped");
    expect(serviceState(svc({ running: false, state: "dead" })).label).toBe("Dead");
    expect(needsAttention(svc({ running: false, state: "exited" }))).toBe(true);
  });
});

describe("uptime", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");

  it("counts days, hours and minutes", () => {
    expect(uptime("2026-01-07T08:00:00Z", now)).toBe("3d 4h");
    expect(uptime("2026-01-10T09:45:00Z", now)).toBe("2h 15m");
    expect(uptime("2026-01-10T11:56:00Z", now)).toBe("4m");
  });

  it("does not invent an uptime for a container with no start time", () => {
    expect(uptime(null, now)).toBe("—");
    expect(uptime("not a date", now)).toBe("—");
  });
});

describe("splitLine", () => {
  it("separates docker's timestamp from the message", () => {
    const { ts, text } = splitLine("2026-01-10T12:00:01.123456789Z INFO started");
    expect(ts).toBe("2026-01-10T12:00:01.123456789Z");
    expect(text).toBe("INFO started");
  });

  it("leaves a line that carries no timestamp intact", () => {
    // A container that writes its own prefix must not lose its first word.
    expect(splitLine("INFO started")).toEqual({ ts: null, text: "INFO started" });
    expect(splitLine("single")).toEqual({ ts: null, text: "single" });
  });
});

describe("sinceOf", () => {
  it("steps back one second from the newest line", () => {
    // docker's `since` is second-granular: rounding forward drops every line
    // written inside the same second as the last one held.
    const ts = "2026-01-10T12:00:30.900000000Z";
    const expected = Math.floor(Date.parse(ts) / 1000) - 1;
    expect(sinceOf(["2026-01-10T12:00:29Z old", `${ts} new`])).toBe(expected);
  });

  it("skips trailing lines that carry no timestamp", () => {
    const ts = "2026-01-10T12:00:30Z";
    const expected = Math.floor(Date.parse(ts) / 1000) - 1;
    expect(sinceOf([`${ts} logged`, "  continuation of a traceback"])).toBe(expected);
  });

  it("is zero when nothing can be read, so the next poll asks for the tail", () => {
    expect(sinceOf([])).toBe(0);
    expect(sinceOf(["no timestamp here"])).toBe(0);
  });
});

describe("lineTone", () => {
  it("colours errors and warnings apart from ordinary output", () => {
    const err = lineTone("ERROR could not connect");
    const warn = lineTone("WARNING retrying");
    const info = lineTone("INFO listening on 8000");
    expect(new Set([err, warn, info]).size).toBe(3);
    expect(lineTone("Traceback (most recent call last):")).toBe(err);
  });

  it("does not colour a word that merely contains a level name", () => {
    // "ERRORS: 0" is a count, not a failure. Word boundaries, not substrings.
    expect(lineTone("INFO cache WARNINGS_TOTAL=0")).toBe(lineTone("INFO x"));
  });
});
