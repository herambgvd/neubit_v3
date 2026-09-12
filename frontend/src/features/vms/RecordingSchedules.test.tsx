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
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("changing a week", () => {
  it("only offers Save once something has been painted", async () => {
    // Enabled from the start, Save would write the stored week back over itself
    // and mark a template as touched when nothing was.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    expect(await screen.findByRole("button", { name: "Save week" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("sends the week that is on screen, not the one that was loaded", async () => {
    authState.value = CAN;
    const stub = stubApi({
      ...routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]),
      "PUT /vms/federation/nodes/n1/recording-schedule-templates/t1": () => ({
        id: "t1",
        name: "Business hours",
      }),
    });
    renderWithProviders(<RecordingSchedules />);

    // Paint Tuesday 09:00, which the stored week leaves off.
    await userEvent.click(await screen.findByLabelText("Tue 09:00 — off"));
    await userEvent.click(screen.getByRole("button", { name: "Save week" }));

    const sent = stub.body(
      "PUT /vms/federation/nodes/n1/recording-schedule-templates/t1",
    ) as { schedule: Record<string, string[]> };
    expect(sent.schedule.Tue[9]).toBe("record");
    // And the day that was already on is still on — a save must not narrow the
    // week to whatever was just touched.
    expect(sent.schedule.Mon[9]).toBe("record");
  });

  it("will not apply a week that has not been saved", async () => {
    // Applying pushes the STORED document. Offering it while a paint is unsaved
    // would put one week on the cameras and leave a different one on screen.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByLabelText("Tue 09:00 — off"));
    expect(screen.getByRole("button", { name: /Apply to cameras/ })).toBeDisabled();
  });

  it("discards a paint back to what the recorder holds", async () => {
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByLabelText("Tue 09:00 — off"));
    expect(screen.getByText("10h / week")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByText("9h / week")).toBeInTheDocument();
  });

  it("says what deleting a template does NOT do", async () => {
    // Cameras keep the schedule they were given — the copy is theirs. Somebody
    // deleting a template must not think they are unscheduling forty cameras.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByTitle("Delete"));
    expect(await screen.findByText(/cameras it was applied to keep the schedule/i)).toBeInTheDocument();
  });
});

/**
 * AND THE REST OF THE SCREEN — the parts that are not the week.
 *
 * Everything below protects a claim the console makes about somebody ELSE'S state:
 * which recorder a schedule belongs to, whether a template still exists, and
 * whether a week survived being renamed. Each is a place where the cheap
 * implementation is silently wrong rather than visibly broken.
 */
const NIGHT = { Mon: Array.from({ length: 24 }, (_, h) => (h >= 22 ? "record" : "off")) };
const ONE_HOUR = { Mon: Array.from({ length: 24 }, (_, h) => (h === 9 ? "record" : "off")) };

/** Two federated recorders, each holding its own templates. */
function twoRecorders() {
  return {
    "GET /vms/federation/nodes": () => ({
      items: [
        { id: "n1", name: "recorder-a" },
        { id: "n2", name: "recorder-b" },
      ],
      total: 2,
    }),
    "GET /vms/federation/nodes/n1/recording-schedule-templates": () => ({
      items: [{ id: "t1", name: "Business hours", schedule: GRID_WEEK }],
      total: 1,
    }),
    "GET /vms/federation/nodes/n2/recording-schedule-templates": () => ({
      items: [{ id: "t9", name: "Night watch", schedule: NIGHT }],
      total: 1,
    }),
    "GET /vms/federation/cameras": () => ({ items: [], total: 0 }),
  };
}

describe("which recorder these belong to", () => {
  it("offers no chooser when there is only one recorder", async () => {
    // With one node the control can only ever say what it already says, and a
    // console full of single-option selects teaches people to ignore selects.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    await screen.findAllByText("Business hours");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the chosen recorder's schedules and nothing of the previous one's", async () => {
    // Templates live ON a recorder. Leaving recorder-a's selection standing while
    // recorder-b's list loads would show one recorder's week under the other's
    // name — and every write from that screen goes to the wrong node.
    authState.value = CAN;
    stubApi(twoRecorders());
    renderWithProviders(<RecordingSchedules />);

    await screen.findAllByText("Business hours");
    await userEvent.selectOptions(screen.getByRole("combobox"), "n2");

    expect(await screen.findAllByText("Night watch")).not.toHaveLength(0);
    expect(screen.queryAllByText("Business hours")).toHaveLength(0);
  });
});

describe("finding one schedule among many", () => {
  const MANY = [
    { id: "t1", name: "Business hours", description: "loading bay is staffed 09:00–18:00", schedule: GRID_WEEK },
    { id: "t2", name: "Night watch", description: "car park after dark", schedule: NIGHT },
  ];

  it("matches on what a schedule is for, not only on its name", async () => {
    // Schedules get named for a place and described by a reason; an operator
    // hunting "the car park one" is searching the sentence, not the title.
    authState.value = CAN;
    stubApi(routes(MANY));
    renderWithProviders(<RecordingSchedules />);

    await screen.findAllByText("Night watch");
    await userEvent.type(screen.getByPlaceholderText("Search schedules…"), "car park");

    expect(screen.queryAllByText("Night watch")).not.toHaveLength(0);
    expect(screen.queryAllByText("Business hours")).toHaveLength(0);
  });

  it("says the rail is FILTERED, not that the recorder has none", async () => {
    // "No named schedules on this recorder yet" in front of a typed search would
    // read as an empty recorder, and the next move is to create a duplicate of
    // something that is already there.
    authState.value = CAN;
    stubApi(routes(MANY));
    renderWithProviders(<RecordingSchedules />);

    await screen.findAllByText("Night watch");
    await userEvent.type(screen.getByPlaceholderText("Search schedules…"), "zzz");

    expect(screen.getByText("No schedule matches that")).toBeInTheDocument();
    expect(screen.queryByText(/No named schedules/i)).toBeNull();
  });
});

describe("painting a week down to nothing", () => {
  it("refuses to save it, and says why rather than failing at the recorder", async () => {
    // The recorder rejects a document with no recording in it. Letting Save fire
    // turns a knowable refusal into a 422 toast about a shape the operator never
    // chose — and leaves them unsure whether the week on screen is stored.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Sparse", schedule: ONE_HOUR }]));
    renderWithProviders(<RecordingSchedules />);

    // The only painted hour, clicked with the same tool, erases.
    await userEvent.click(await screen.findByLabelText("Mon 09:00 — continuous"));

    expect(screen.getByText(/Nothing is scheduled/i)).toBeInTheDocument();
    // Dirty — Discard is offered — and still not saveable.
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save week" })).toBeDisabled();
  });
});

describe("naming a schedule", () => {
  it("creates one with a week already in it", async () => {
    // A template whose whole job is to hold a schedule must carry one: the
    // recorder refuses an empty document, so "create" from a blank grid fails on
    // the first press with a validation error nobody asked for.
    authState.value = CAN;
    const stub = stubApi({
      ...routes([]),
      "POST /vms/federation/nodes/n1/recording-schedule-templates": () => ({
        id: "t2",
        name: "Loading bay",
        schedule: GRID_WEEK,
      }),
    });
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByTitle("New schedule"));
    await userEvent.type(screen.getByPlaceholderText("Business hours"), "Loading bay");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const sent = stub.body("POST /vms/federation/nodes/n1/recording-schedule-templates") as {
      name: string;
      schedule: Record<string, string[]>;
    };
    expect(sent.name).toBe("Loading bay");
    expect(sent.schedule.Mon[9]).toBe("record");
    expect(sent.schedule.Sat.every((s) => s === "off")).toBe(true);
  });

  it("drops the operator on the week they just created", async () => {
    // Creating is half the act — the week is painted on the screen behind. Landing
    // back on whatever was selected before makes the next paint edit the wrong
    // template.
    authState.value = CAN;
    let list: unknown[] = [{ id: "t1", name: "Business hours", schedule: GRID_WEEK }];
    stubApi({
      "GET /vms/federation/nodes": () => ({ items: [{ id: "n1", name: "recorder-a" }], total: 1 }),
      "GET /vms/federation/nodes/n1/recording-schedule-templates": () => ({
        items: list,
        total: list.length,
      }),
      "GET /vms/federation/cameras": () => ({ items: [], total: 0 }),
      "POST /vms/federation/nodes/n1/recording-schedule-templates": () => {
        const saved = { id: "t2", name: "Loading bay", schedule: NIGHT };
        list = [...list, saved];
        return saved;
      },
    });
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByTitle("New schedule"));
    await userEvent.type(screen.getByPlaceholderText("Business hours"), "Loading bay");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    // NIGHT is 22:00–24:00 — two hours, and only the new template's week is.
    expect(await screen.findByText("2h / week")).toBeInTheDocument();
  });

  it("renames without blanking the week it is renaming", async () => {
    // The node's PUT REPLACES the template. A rename that sent only a name would
    // silently unschedule the camera-facing document it was renaming, and nothing
    // on screen would say so.
    authState.value = CAN;
    const stub = stubApi({
      ...routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]),
      "PUT /vms/federation/nodes/n1/recording-schedule-templates/t1": () => ({
        id: "t1",
        name: "Loading bay",
        schedule: GRID_WEEK,
      }),
    });
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByTitle("Rename"));
    const field = screen.getByPlaceholderText("Business hours");
    expect(field).toHaveValue("Business hours");
    await userEvent.clear(field);
    await userEvent.type(field, "Loading bay");
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Rename" }),
    );

    const sent = stub.body("PUT /vms/federation/nodes/n1/recording-schedule-templates/t1") as {
      name: string;
      schedule: Record<string, string[]>;
    };
    expect(sent.name).toBe("Loading bay");
    expect(sent.schedule.Mon[9]).toBe("record");
  });
});

describe("pushing a week onto cameras", () => {
  it("opens the apply dialog for the schedule that is on screen", async () => {
    // Apply is per-template and per-node. A dialog opened for anything but the
    // selected template would fan a different week out to forty cameras.
    authState.value = CAN;
    stubApi(routes([{ id: "t1", name: "Business hours", schedule: GRID_WEEK }]));
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByRole("button", { name: /Apply to cameras/ }));

    expect(await screen.findByText(/Apply .Business hours./)).toBeInTheDocument();
  });
});

describe("deleting a template", () => {
  it("deletes it on the recorder that holds it, and takes nothing else with it", async () => {
    // The template is a VMS-side stencil; the cameras hold copies. Deleting must
    // reach exactly one node-scoped endpoint — a delete sent to the wrong node
    // either 404s or removes a stranger's schedule.
    authState.value = CAN;
    let list: unknown[] = [{ id: "t1", name: "Business hours", schedule: GRID_WEEK }];
    const stub = stubApi({
      "GET /vms/federation/nodes": () => ({ items: [{ id: "n1", name: "recorder-a" }], total: 1 }),
      "GET /vms/federation/nodes/n1/recording-schedule-templates": () => ({
        items: list,
        total: list.length,
      }),
      "GET /vms/federation/cameras": () => ({ items: [], total: 0 }),
      "DELETE /vms/federation/nodes/n1/recording-schedule-templates/t1": () => {
        list = [];
        return null;
      },
    });
    renderWithProviders(<RecordingSchedules />);

    await userEvent.click(await screen.findByTitle("Delete"));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
    );

    expect(
      stub.matching("DELETE /vms/federation/nodes/n1/recording-schedule-templates/t1"),
    ).toHaveLength(1);
    expect(await screen.findByText("No schedule selected")).toBeInTheDocument();
  });
});
