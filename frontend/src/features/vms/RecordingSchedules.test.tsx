/**
 * THE TWO THINGS THIS SCREEN MUST NOT LET SOMEBODY BELIEVE.
 *
 * 1. That a week it cannot draw means a camera records nothing. The recorder
 *    accepts two schedule shapes and may hold one written by a sibling console;
 *    rendering an empty grid for it would make the specific, alarming claim
 *    "nothing is scheduled" about what is only a parse failure here.
 *
 * 2. That a schedule means footage. A camera in `manual` mode holds its week and
 *    ignores it, so the apply dialog names those cameras BEFORE the write rather
 *    than leaving them to be discovered from an empty timeline later.
 */
import { describe, expect, it } from "vitest";

import { railSummary } from "./RecordingSchedules";
import { ignoresSchedule } from "./components/ApplyScheduleModal";
import { starterWeek } from "./components/ScheduleTemplateModal";
import { coveredHours, docToWeek } from "./components/weekSchedule";

const GRID_9_TO_18 = {
  Mon: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 18 ? "record" : "off")),
};

describe("what the rail says about a schedule", () => {
  it("counts the hours, because that is what two named weeks are compared on", () => {
    expect(railSummary({ id: "t", name: "Business hours", schedule: GRID_9_TO_18 })).toBe(
      "9h scheduled per week",
    );
  });

  it("says a week it cannot read is in another shape — never that it records nothing", () => {
    // The distinction the whole screen turns on. "records nothing" is a claim
    // about the camera; this is a statement about this console.
    expect(railSummary({ id: "t", name: "Legacy", schedule: { notaday: [] } })).toBe(
      "written in another shape",
    );
  });

  it("does say it records nothing when that is actually true", () => {
    const allOff = { Mon: Array.from({ length: 24 }, () => "off") };
    expect(railSummary({ id: "t", name: "Empty", schedule: allOff })).toBe("records nothing");
  });
});

describe("which cameras will ignore the schedule", () => {
  it("flags a camera in manual mode", () => {
    expect(ignoresSchedule({ id: "c", name: "Ch 1", node_id: "n", node_name: "r", recording: { mode: "manual" } })).toBe(true);
  });

  it("does not flag one in schedule mode", () => {
    expect(ignoresSchedule({ id: "c", name: "Ch 1", node_id: "n", node_name: "r", recording: { mode: "schedule" } })).toBe(false);
  });

  it("says nothing when the recorder did not say", () => {
    // Silence is not "manual". Guessing a mode the recorder never reported would
    // put a warning on a camera that is fine, and the warning stops being read.
    expect(ignoresSchedule({ id: "c", name: "Ch 1", node_id: "n", node_name: "r" })).toBe(false);
    expect(ignoresSchedule({ id: "c", name: "Ch 1", node_id: "n", node_name: "r", recording: { mode: "" } })).toBe(false);
  });
});

describe("a new template", () => {
  it("is born with a week in it, because the recorder refuses an empty one", () => {
    // A template whose whole job is to set a schedule must carry one; creating
    // from a blank grid would 422 with a validation error about a shape the
    // operator never chose.
    const week = starterWeek();
    expect(coveredHours(week)).toBe(45); // five days, nine hours
    expect(week[5].every((s) => s === "off")).toBe(true); // and the weekend is off
  });

  it("is a week this console can read back", () => {
    expect(docToWeek({ Mon: starterWeek()[0] })).not.toBeNull();
  });
});
