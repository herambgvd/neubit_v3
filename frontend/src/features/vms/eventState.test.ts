/**
 * An event is an INTERVAL, and the live estate proves why that matters: 55 of 59
 * rows carry an end, FOUR do not, and one of those has been open thirteen hours.
 * The console drew every one of them as a point in time, so a camera dark since
 * breakfast looked exactly like a motion blip.
 *
 * The cases worth pinning are the broken ones. The recorder sometimes reports an
 * end BEFORE the start (a zeroed timestamp — observed as −59960670631 seconds),
 * and a bar drawn from that would be the console inventing a fact.
 */
import { describe, expect, it } from "vitest";

import {
  durationLabel,
  eventInterval,
  formatDuration,
  openEvents,
  openFor,
} from "./eventState";

const NOW = Date.parse("2026-09-10T12:00:00Z");

const ev = (raw: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ raw, severity: "alarm", acknowledged: false, ...over }) as never;

describe("an open event", () => {
  it("is stateful with no end — still happening", () => {
    const e = ev({ stateful: true, started_at: "2026-09-09T22:38:00Z", ended_at: null });
    expect(eventInterval(e).open).toBe(true);
    expect(openFor(e, NOW)).toBe(13 * 3_600_000 + 22 * 60_000);
  });

  it("is NOT every event that lacks an end", () => {
    // A motion pulse carries no end because it was instantaneous. Calling it open
    // would pin every blip to the top of the screen forever.
    expect(eventInterval(ev({ stateful: false, started_at: "2026-09-10T11:00:00Z" })).open).toBe(false);
  });

  it("reads as zero elapsed when the recorder's clock is ahead", () => {
    const e = ev({ stateful: true, started_at: "2026-09-10T12:05:00Z", ended_at: null });
    expect(openFor(e, NOW)).toBe(0);
  });

  it("leads the list, longest-running first", () => {
    const old = ev({ stateful: true, started_at: "2026-09-09T22:00:00Z" }, { id: "old" });
    const recent = ev({ stateful: true, started_at: "2026-09-10T11:00:00Z" }, { id: "recent" });
    const closed = ev({ stateful: true, started_at: "2026-09-10T10:00:00Z", ended_at: "2026-09-10T10:05:00Z" }, { id: "closed" });

    expect(openEvents([recent, closed, old]).map((e) => (e as { id: string }).id)).toEqual(["old", "recent"]);
  });
});

describe("a closed event", () => {
  it("carries the span the recorder measured", () => {
    const iv = eventInterval(ev({ started_at: "2026-09-09T09:51:00Z", ended_at: "2026-09-09T15:09:00Z" }));
    expect(iv.durationMs).toBe(5 * 3_600_000 + 18 * 60_000);
    expect(iv.invalid).toBe(false);
  });

  it("refuses to draw a span that ends before it starts", () => {
    // Observed on the live ledger: an end of 1970 against a start of today.
    const iv = eventInterval(ev({ started_at: "2026-09-09T09:51:00Z", ended_at: "1970-01-01T00:00:00Z" }));
    expect(iv.invalid).toBe(true);
    expect(iv.durationMs).toBeNull();
    expect(durationLabel(ev({ started_at: "2026-09-09T09:51:00Z", ended_at: "1970-01-01T00:00:00Z" }), NOW))
      .toBe("duration unreliable");
  });

  it("says nothing at all for an instantaneous one", () => {
    // "0s" reads as a measurement of nothing.
    expect(durationLabel(ev({ started_at: "2026-09-10T11:00:00Z", ended_at: "2026-09-10T11:00:00Z" }), NOW)).toBeNull();
  });
});

describe("the words a duration is said in", () => {
  it("uses the unit an operator would say out loud", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(5 * 60_000 + 4_000)).toBe("5m 04s");
    expect(formatDuration(13 * 3_600_000 + 22 * 60_000)).toBe("13h 22m");
    expect(formatDuration(50 * 3_600_000)).toBe("2d 2h");
  });

  it("says nothing rather than a number it does not have", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  it("labels an open event as ongoing, with the time so far", () => {
    const e = ev({ stateful: true, started_at: "2026-09-10T11:30:00Z", ended_at: null });
    expect(durationLabel(e, NOW)).toBe("ongoing 30m 00s");
  });
});
