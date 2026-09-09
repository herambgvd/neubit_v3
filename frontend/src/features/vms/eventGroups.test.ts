/**
 * The feed's day headers and elapsed times.
 *
 * Both are pure and both have a boundary a rendered test cannot pin: "Today" is
 * a LOCAL calendar day (an ISO date built with toISOString() is the previous day
 * for anyone east of UTC before their morning), and a feed that mislabels the
 * day is worse than one with no headers at all.
 */
import { describe, expect, it } from "vitest";

import { ago, dayLabel, groupByDay, localDayKey } from "./eventGroups";

const NOW = new Date(2026, 8, 9, 14, 30, 0); // 9 Sep 2026, local

const ev = (iso: string) => ({ occurred_at: iso }) as never;

describe("day keys", () => {
  it("are the LOCAL day, not the UTC one", () => {
    // 00:30 local on the 9th is still the 8th in UTC for a +05:30 estate.
    const local0030 = new Date(2026, 8, 9, 0, 30, 0);
    expect(localDayKey(local0030.toISOString(), NOW)).toBe("2026-09-09");
  });

  it("name today and yesterday, and date anything older", () => {
    expect(dayLabel("2026-09-09", NOW)).toBe("Today");
    expect(dayLabel("2026-09-08", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-09-06", NOW)).toMatch(/Sep/);
  });
});

describe("grouping", () => {
  it("buckets by day and keeps the order it was given", () => {
    const groups = groupByDay(
      [
        ev(new Date(2026, 8, 9, 14, 0).toISOString()),
        ev(new Date(2026, 8, 9, 9, 0).toISOString()),
        ev(new Date(2026, 8, 8, 23, 0).toISOString()),
      ],
      NOW,
    );

    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[1].events).toHaveLength(1);
  });

  it("does not re-sort — live frames arrive prepended and stay there", () => {
    const later = ev(new Date(2026, 8, 9, 14, 25).toISOString());
    const earlier = ev(new Date(2026, 8, 9, 8, 0).toISOString());
    const groups = groupByDay([later, earlier], NOW);
    expect(groups[0].events[0]).toBe(later);
  });

  it("returns nothing for an empty feed rather than an empty bucket", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("elapsed time", () => {
  it("reads in the units an operator thinks in", () => {
    expect(ago(new Date(NOW.getTime() - 10_000).toISOString(), NOW)).toBe("just now");
    expect(ago(new Date(NOW.getTime() - 4 * 60_000).toISOString(), NOW)).toBe("4m");
    expect(ago(new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), NOW)).toBe("2h");
    expect(ago(new Date(NOW.getTime() - 3 * 86_400_000).toISOString(), NOW)).toBe("3d");
  });

  it("says nothing rather than guessing when there is no timestamp", () => {
    expect(ago(null, NOW)).toBe("—");
    expect(ago("not-a-date", NOW)).toBe("—");
  });
});
