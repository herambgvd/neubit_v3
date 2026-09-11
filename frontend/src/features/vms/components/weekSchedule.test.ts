/**
 * A SCHEDULE THE CONSOLE DRAWS MUST BE THE SCHEDULE THE RECORDER RUNS.
 *
 * The document belongs to the recorder, which accepts two shapes and evaluates
 * them with rules this module has to mirror exactly. Every case below is taken
 * from the Go that runs it (internal/recording/schedule.go), because a painter
 * that disagrees with the evaluator shows an operator a week that is not the one
 * being recorded — and it disagrees silently, forever.
 */
import { describe, expect, it } from "vitest";

import {
  DAYS,
  coveredHours,
  docToWeek,
  emptyWeek,
  hhmm,
  isAllOff,
  rowOf,
  slotOf,
  weekToDoc,
} from "./weekSchedule";

const MON = 0;
const TUE = 1;
const SUN = 6;

function grid(day: string, hours: Record<number, string>): Record<string, string[]> {
  const row = Array<string>(24).fill("off");
  for (const [h, v] of Object.entries(hours)) row[Number(h)] = v;
  return { [day]: row };
}

describe("reading a document the recorder would accept", () => {
  it("reads the weekly grid, in every slot vocabulary the siblings write", () => {
    // "continuous" is gvd_nvr's word, "record" is this console's, and the recorder
    // normalises both. A painter that knew only its own would draw a schedule
    // written next door as entirely off.
    const week = docToWeek(grid("Mon", { 9: "continuous", 10: "record", 11: "motion", 12: "event" }));
    expect(week).not.toBeNull();
    expect(week![MON].slice(9, 13)).toEqual(["record", "record", "motion", "motion"]);
  });

  it("reads day windows, and lights an hour the window only partly covers", () => {
    // 09:30–18:00 keeps footage from 09:30. Rounding 09:00 away would hide half an
    // hour of recording that exists.
    const week = docToWeek({ monday: [{ start: "09:30", end: "18:00" }] });
    expect(week![MON][9]).toBe("record");
    expect(week![MON][17]).toBe("record");
    expect(week![MON][18]).toBe("off");
  });

  it("wraps an overnight window onto the SAME day, as evalWindows does", () => {
    // The recorder tests `nowMin >= start || nowMin < end` against THAT DAY's own
    // rules, so Tuesday 02:00 matches Tuesday's 22:00–06:00. Drawing the tail on
    // Wednesday would disagree with the machine that runs it.
    const week = docToWeek({ tuesday: [{ start: "22:00", end: "06:00" }] });
    expect(week![TUE][23]).toBe("record");
    expect(week![TUE][2]).toBe("record");
    expect(week![TUE][12]).toBe("off");
    expect(week![MON][23]).toBe("off");
  });

  it("spreads an everyday window across all seven days", () => {
    const week = docToWeek({ everyday: [{ start: "09:00", end: "10:00" }] });
    expect(week!.every((row) => row[9] === "record")).toBe(true);
  });

  it("accepts every day spelling the recorder's own parser accepts", () => {
    // weekdayOf takes "Mon", "monday" and " MONDAY " alike. A document it calls
    // valid that this refuses to draw is a schedule the operator cannot edit.
    for (const key of ["Mon", "mon", "monday", "Monday", " MONDAY "]) {
      const week = docToWeek(grid(key, { 9: "record" }));
      expect(week, key).not.toBeNull();
      expect(week![MON][9], key).toBe("record");
    }
  });

  it("puts Sunday last, where an operator's week ends", () => {
    const week = docToWeek(grid("Sun", { 9: "record" }));
    expect(week![SUN][9]).toBe("record");
    expect(week![MON][9]).toBe("off");
  });
});

describe("refusing to draw what it cannot read", () => {
  // The whole point. An unreadable document must NOT become an empty week: an
  // empty week is the specific claim "this camera records nothing", and making
  // that claim about a parse failure tells somebody they are uncovered when they
  // are not.
  it.each([
    ["a day that is not a day", { notaday: [] }],
    ["a grid row that is not 24 hours", { Mon: ["record", "record"] }],
    ["a window with an unparseable time", { monday: [{ start: "9am", end: "6pm" }] }],
    ["an empty document", {}],
    ["null", null],
  ])("returns null for %s", (_label, doc) => {
    expect(docToWeek(doc as never)).toBeNull();
  });

  it("rejects the WHOLE document when one grid row is short", () => {
    // A half-read grid would draw the other days confidently and be wrong about
    // this one, which is worse than drawing nothing.
    const doc = { ...grid("Mon", { 9: "record" }), Tue: ["record"] };
    expect(docToWeek(doc)).toBeNull();
  });
});

describe("writing what was painted", () => {
  it("round-trips through the recorder's grid shape", () => {
    const week = emptyWeek();
    week[MON][9] = "record";
    week[SUN][22] = "motion";
    const back = docToWeek(weekToDoc(week));
    expect(back).toEqual(week);
  });

  it("writes every day, including the ones that are entirely off", () => {
    // A missing day is off to the recorder anyway; writing it makes the document
    // say what the operator saw instead of leaving the next reader to infer it.
    expect(Object.keys(weekToDoc(emptyWeek())).sort()).toEqual([...DAYS].sort());
  });
});

describe("the small answers the screen needs", () => {
  it("counts motion as covered — it is still a plan to record", () => {
    const week = emptyWeek();
    week[MON][9] = "record";
    week[MON][10] = "motion";
    expect(coveredHours(week)).toBe(2);
    expect(isAllOff(week)).toBe(false);
  });

  it("knows a week that does nothing", () => {
    expect(isAllOff(emptyWeek())).toBe(true);
  });

  it("maps an unknown slot word to off, never to recording", () => {
    expect(slotOf("whatever")).toBe("off");
    expect(slotOf(undefined)).toBe("off");
  });

  it("reads a clock time, and refuses a broken one", () => {
    expect(hhmm("09:30")).toBe(570);
    expect(hhmm("24:00")).toBe(1440);
    expect(hhmm("9:5")).toBeNull();
    expect(hhmm("25:00")).toBeNull();
  });

  it("has no row for a word that is not a day", () => {
    expect(rowOf("funday")).toBe(-1);
  });
});
