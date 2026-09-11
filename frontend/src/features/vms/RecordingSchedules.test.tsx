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
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import RecordingSchedules, { railSummary } from "./RecordingSchedules";
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

/**
 * AND THE SCREEN ITSELF.
 *
 * Three states matter here and none of them is the happy path: no recorder at all,
 * a week this painter cannot draw, and an operator without the right to change
 * anything. Each is a different sentence, and getting one of them wrong is how a
 * console tells somebody they are covered when they are not.
 */
const CAN = { can: (p: string) => p === "vms.camera.read" || p === "vms.config.manage" };
const READ_ONLY = { can: (p: string) => p === "vms.camera.read" };

vi.mock("@/lib/auth", () => ({ useAuth: () => authState.value }));
const authState: { value: { can: (p: string) => boolean } } = { value: CAN };

const GRID_WEEK = { Mon: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 18 ? "record" : "off")) };

function routes(templates: unknown[], nodes: unknown[] = [{ id: "n1", name: "recorder-a" }]) {
  return {
    "GET /vms/federation/nodes": () => ({ items: nodes, total: nodes.length }),
    "GET /vms/federation/nodes/n1/recording-schedule-templates": () => ({
      items: templates,
      total: templates.length,
    }),
    "GET /vms/federation/cameras": () => ({ items: [], total: 0 }),
  };
}

describe("the schedules screen", () => {
  it("says there is nothing to schedule when no recorder is federated", async () => {
    authState.value = CAN;
    stubApi(routes([], []));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByText(/No recorder is federated yet/i)).toBeInTheDocument();
  });

  it("paints a week the recorder gave it", async () => {
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByText("9h / week")).toBeInTheDocument();
    // Mon 09:00 is inside the window and must announce itself as such.
    expect(screen.getByLabelText("Mon 09:00 — continuous")).toBeInTheDocument();
  });

  it("refuses to draw a week it cannot read, and says so", async () => {
    // The load-bearing branch: an empty grid here would claim the camera records
    // nothing, which is a different and alarming statement.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Legacy", schedule: { notaday: [] } }]));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByText(/cannot be drawn here/i)).toBeInTheDocument();
    expect(screen.queryByText(/h \/ week/)).toBeNull();
  });

  it("is read-only without config rights, and says why", async () => {
    authState.value = READ_ONLY;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByText(/changing a schedule needs config rights/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save week" })).toBeNull();
  });

  it("never implies that editing a template reaches cameras it was applied to", async () => {
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByText(/does not reach back into cameras already set/i)).toBeInTheDocument();
  });
});
