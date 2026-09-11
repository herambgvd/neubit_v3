/**
 * PUSHING ONE WEEK ONTO MANY CAMERAS.
 *
 * A fan-out nobody watches has to be readable afterwards, and the things that can
 * go quietly wrong here are all about what the operator is told rather than what
 * the request contains:
 *
 *   * a camera in `manual` mode takes the week and ignores it. Said BEFORE the
 *     button, or it is discovered later from an empty timeline;
 *   * the recorder answers per camera, and "40 applied, 10 failed" is not a
 *     success — the per-row outcome has to reach the screen;
 *   * only THIS recorder's cameras can be applied to, because apply is a
 *     node-scoped call and offering another's would produce a page of failures.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import ApplyScheduleModal, { ignoresSchedule } from "./ApplyScheduleModal";
import type { ScheduleTemplate } from "../types";

const TEMPLATE = { id: "t1", name: "Business hours" } as ScheduleTemplate;

const CAMERAS = [
  { id: "c1", name: "Channel 1", node_id: "n1", node_name: "recorder-a", recording: { mode: "manual" } },
  { id: "c2", name: "Channel 2", node_id: "n1", node_name: "recorder-a", recording: { mode: "schedule" } },
  { id: "c9", name: "Other recorder cam", node_id: "n2", node_name: "recorder-b", recording: { mode: "schedule" } },
];

function open(apply?: () => unknown) {
  const stub = stubApi({
    "GET /vms/federation/cameras": () => ({ items: CAMERAS, total: CAMERAS.length }),
    "POST /vms/federation/nodes/n1/recording-schedule-templates/t1/apply":
      apply ?? (() => ({ template_id: "t1", requested: 1, applied: 1, skipped: 0, failed: 0, results: [] })),
  });
  renderWithProviders(
    <ApplyScheduleModal nodeId="n1" template={TEMPLATE} onClose={() => {}} />,
  );
  return stub;
}

describe("which cameras are offered", () => {
  it("lists this recorder's cameras only", async () => {
    open();
    expect(await screen.findByText("Channel 1")).toBeInTheDocument();
    expect(screen.getByText("Channel 2")).toBeInTheDocument();
    // Applying is node-scoped; another recorder's camera could only fail.
    expect(screen.queryByText("Other recorder cam")).toBeNull();
  });

  it("marks the ones that will hold the week without acting on it", async () => {
    open();
    expect(await screen.findByText(/in manual mode — it will hold this week/i)).toBeInTheDocument();
  });
});

describe("before the button is pressed", () => {
  it("warns when a selected camera is not in schedule mode", async () => {
    open();
    await screen.findByText("Channel 1");
    // Channel 1 is the one in manual mode.
    await userEvent.click(screen.getAllByRole("checkbox")[0]);

    expect(
      await screen.findByText(/not in\s+schedule mode|1 of the selected camera is/i),
    ).toBeInTheDocument();
  });

  it("counts what is about to happen, in the right grammar", async () => {
    open();
    // Nothing picked yet.
    expect(await screen.findByRole("button", { name: /Apply to no cameras/ })).toBeInTheDocument();
    await screen.findByText("Channel 1");

    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: "Apply to 1 camera" })).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByRole("button", { name: "Apply to 2 cameras" })).toBeInTheDocument();
  });
});

describe("after the fan-out", () => {
  it("shows the recorder's outcome for each camera", async () => {
    open(() => ({
      template_id: "t1",
      requested: 2,
      applied: 1,
      skipped: 0,
      failed: 1,
      results: [
        { camera_id: "c1", status: "applied" },
        { camera_id: "c2", status: "failed", reason: "camera is gone" },
      ],
    }));
    await screen.findByText("Channel 1");
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getAllByRole("checkbox")[1]);
    await userEvent.click(screen.getByRole("button", { name: /Apply to/ }));

    expect(await screen.findByText("applied")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
    // And the audit line, because a count is the only record of a fan-out.
    expect(screen.getByText(/1 applied · 0 skipped · 1 failed of 2 requested/)).toBeInTheDocument();
  });
});

describe("reading a camera's mode", () => {
  it("treats silence as silence, not as manual", () => {
    // Guessing a mode the recorder never reported would warn about a camera that
    // is fine, and a warning that cries wolf stops being read.
    expect(ignoresSchedule({ id: "c", name: "x", node_id: "n", node_name: "r" })).toBe(false);
  });
});
