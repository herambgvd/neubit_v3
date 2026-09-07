/**
 * The pure helpers every screen formats through. Two things are pinned here:
 *
 *   1. `asItems` normalises all four shapes a list endpoint can hand it — bare
 *      array, { items } envelope, nothing-at-all, and the `ItemList<T> | T[]`
 *      union — and keeps the ELEMENT TYPE while doing so. The union case is not
 *      hypothetical: neither branch of it used to match, so every list typed that
 *      way silently collapsed to `unknown[]`. The `expectTypeOf` assertions below
 *      fail the typecheck, not the run, which is exactly where that bug lived.
 *   2. The display formatters never render a raw null, NaN or "Invalid Date" —
 *      an operator sees an em dash instead.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  asItems,
  fmtBytes,
  fmtDateTime,
  fmtDuration,
  fmtRelative,
  idOf,
  titleize,
  type ItemsOf,
} from "./format";

interface Camera {
  id: string;
  name: string;
}

/** The two shapes a list endpoint answers with, as a react-query `.data` would
 *  type it: undefined until the query resolves. */
type CameraList = { items?: Camera[] | null; total?: number } | Camera[] | undefined;

const CAM: Camera = { id: "c1", name: "Lobby" };

afterEach(() => {
  vi.useRealTimers();
});

describe("asItems", () => {
  it("passes a bare array through untouched", () => {
    const rows = [CAM];
    expect(asItems(rows)).toEqual([CAM]);
  });

  it("unwraps the { items, total } envelope to its items", () => {
    expect(asItems({ items: [CAM], total: 1 })).toEqual([CAM]);
  });

  it("yields an empty array for the not-yet-loaded and null cases, never undefined", () => {
    expect(asItems(undefined)).toEqual([]);
    expect(asItems(null)).toEqual([]);
    expect(asItems({ items: null })).toEqual([]);
    expect(asItems({})).toEqual([]);
  });

  it("accepts either half of the `envelope or bare array` union at runtime", () => {
    const envelope: CameraList = { items: [CAM], total: 1 };
    const bare: CameraList = [CAM];
    const pending: CameraList = undefined;

    expect(asItems(envelope)).toEqual([CAM]);
    expect(asItems(bare)).toEqual([CAM]);
    expect(asItems(pending)).toEqual([]);
  });

  it("keeps the element type across all four shapes — the union must not degrade to unknown[]", () => {
    expectTypeOf<ItemsOf<Camera[]>>().toEqualTypeOf<Camera[]>();
    expectTypeOf<ItemsOf<{ items?: Camera[] | null }>>().toEqualTypeOf<Camera[]>();
    expectTypeOf<ItemsOf<CameraList>>().toEqualTypeOf<Camera[]>();
    // The `.data` of a resolved query is still `T | undefined`; a caller must be
    // able to write `asItems(data).map(c => c.name)` without a cast.
    const rows = asItems({ items: [CAM] } as CameraList);
    expectTypeOf(rows).toEqualTypeOf<Camera[]>();
    expect(rows.map((c) => c.name)).toEqual(["Lobby"]);
  });

  it("returns a real array a caller can map over while the query is still pending", () => {
    // The reason it returns [] rather than null: every call site maps immediately,
    // and it must typecheck against a `.data` that has not arrived yet.
    const names = (data: CameraList) => asItems(data).map((c) => c.name);
    expect(names(undefined)).toEqual([]);
    expect(names({ items: [CAM] })).toEqual(["Lobby"]);
  });
});

describe("idOf", () => {
  it("returns the first key that is actually present", () => {
    expect(idOf({ sop_id: "s1" }, "id", "sop_id")).toBe("s1");
    expect(idOf({ id: "a", sop_id: "s1" }, "id", "sop_id")).toBe("a");
  });

  it("skips a key whose value is null or undefined rather than returning it", () => {
    expect(idOf({ id: null, state_id: "st1" }, "id", "state_id")).toBe("st1");
    expect(idOf({ id: undefined, state_id: "st1" }, "id", "state_id")).toBe("st1");
  });

  it("keeps a falsy-but-present id, because 0 and \"\" are real values", () => {
    expect(idOf({ id: 0 }, "id")).toBe(0);
  });

  it("is undefined when the object is missing or has none of the keys", () => {
    expect(idOf(null, "id")).toBeUndefined();
    expect(idOf(undefined, "id")).toBeUndefined();
    expect(idOf({ name: "x" }, "id", "sop_id")).toBeUndefined();
  });
});

describe("titleize", () => {
  it("turns a wire enum into words with each one capitalised", () => {
    expect(titleize("fire_alarm")).toBe("Fire Alarm");
    expect(titleize("in_progress")).toBe("In Progress");
  });

  it("renders an em dash for every nothing-value instead of blank or \"null\"", () => {
    expect(titleize(null)).toBe("—");
    expect(titleize(undefined)).toBe("—");
    expect(titleize("")).toBe("—");
  });
});

describe("fmtRelative", () => {
  it("reads as `Just now` inside the first minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
    expect(fmtRelative("2026-01-10T11:59:31Z")).toBe("Just now");
  });

  it("counts in whole minutes below an hour and whole hours below a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
    expect(fmtRelative("2026-01-10T11:55:00Z")).toBe("5m ago");
    expect(fmtRelative("2026-01-10T09:00:00Z")).toBe("3h ago");
    expect(fmtRelative("2026-01-10T11:00:30Z")).toBe("59m ago");
  });

  it("switches to an absolute date once the event is over a day old", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00Z"));
    const out = fmtRelative("2026-01-01T12:00:00Z");
    expect(out).not.toMatch(/ago|Just now/);
    expect(out).toContain("1");
  });

  it("renders an em dash rather than `Invalid Date` for junk or nothing", () => {
    expect(fmtRelative(null)).toBe("—");
    expect(fmtRelative(undefined)).toBe("—");
    expect(fmtRelative("")).toBe("—");
    expect(fmtRelative("not-a-date")).toBe("—");
  });
});

describe("fmtDateTime", () => {
  it("renders an em dash rather than `Invalid Date` for junk or nothing", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime("nonsense")).toBe("—");
  });

  it("formats a real timestamp into something with the day number in it", () => {
    expect(fmtDateTime("2026-01-10T12:00:00Z")).toMatch(/\d/);
    expect(fmtDateTime("2026-01-10T12:00:00Z")).not.toContain("Invalid");
  });
});

describe("fmtBytes", () => {
  it("scales to the largest unit that keeps the number readable", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MB");
    expect(fmtBytes(1024 ** 3 * 2.5)).toBe("2.5 GB");
  });

  it("shows no decimal for plain bytes and one everywhere above", () => {
    expect(fmtBytes(999)).toBe("999 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
  });

  it("stops at the largest known unit instead of running off the array", () => {
    expect(fmtBytes(1024 ** 6)).toBe("1024.0 PB");
  });

  it("reports 0 B for nothing, zero, negative and non-numeric input", () => {
    expect(fmtBytes(null)).toBe("0 B");
    expect(fmtBytes(undefined)).toBe("0 B");
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(-5)).toBe("0 B");
    expect(fmtBytes("abc")).toBe("0 B");
  });

  it("accepts the numeric string the backend sends for large sizes", () => {
    expect(fmtBytes("2048")).toBe("2.0 KB");
  });
});

describe("fmtDuration", () => {
  it("drops the units that would be zero from the left", () => {
    expect(fmtDuration(3)).toBe("3s");
    expect(fmtDuration(303)).toBe("5m 3s");
    expect(fmtDuration(3903)).toBe("1h 5m 3s");
  });

  it("keeps an inner zero unit so `1h 0m 3s` is not read as 1h3s", () => {
    expect(fmtDuration(3603)).toBe("1h 0m 3s");
  });

  it("renders an em dash for nothing, zero and negative durations", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(0)).toBe("—");
    expect(fmtDuration(-1)).toBe("—");
    expect(fmtDuration("x")).toBe("—");
  });
});
