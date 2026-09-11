/**
 * NAMING A SCHEDULE — and the two ways the WEEK can be lost while doing it.
 *
 * The node's PUT REPLACES a template, so a rename that sends no schedule blanks
 * the one being renamed. And the node REFUSES an empty document, so a create that
 * sends a blank grid fails with a validation error about a shape the operator
 * never chose. Both are invisible from the dialog itself — it only asks for a
 * name — which is exactly why they are worth a test.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi } from "@/test/apiStub";
import ScheduleTemplateModal, { starterWeek } from "./ScheduleTemplateModal";
import { coveredHours, docToWeek } from "./weekSchedule";
import type { ScheduleTemplate } from "../types";

const EXISTING_WEEK = { Mon: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 18 ? "record" : "off")) };
const EXISTING = { id: "t1", name: "Business hours", description: "Weekdays", schedule: EXISTING_WEEK } as ScheduleTemplate;

describe("creating one", () => {
  it("sends a week with recording in it, because the recorder refuses an empty one", async () => {
    const stub = stubApi({
      "POST /vms/federation/nodes/n1/recording-schedule-templates": () => ({ id: "t2", name: "Overnight" }),
    });
    renderWithProviders(<ScheduleTemplateModal nodeId="n1" onClose={() => {}} onSaved={() => {}} />);

    await userEvent.type(screen.getByRole("textbox", { name: /^Name/ }), "Overnight");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const sent = stub.calls.at(-1)?.body as { schedule: Record<string, unknown> };
    const week = docToWeek(sent.schedule);
    expect(week).not.toBeNull();
    expect(coveredHours(week!)).toBe(45); // the starter: five days, nine hours
  });

  it("will not create without a name", async () => {
    stubApi({});
    renderWithProviders(<ScheduleTemplateModal nodeId="n1" onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});

describe("renaming one", () => {
  it("carries the existing week back UNCHANGED", async () => {
    // The node's PUT replaces the template. Sending {name} alone would rename it
    // and blank the week in the same request, and nothing on this dialog would
    // show that happening.
    const stub = stubApi({
      "PUT /vms/federation/nodes/n1/recording-schedule-templates/t1": () => ({ ...EXISTING, name: "Office hours" }),
    });
    renderWithProviders(
      <ScheduleTemplateModal nodeId="n1" template={EXISTING} onClose={() => {}} onSaved={() => {}} />,
    );

    const name = screen.getByRole("textbox", { name: /^Name/ });
    await userEvent.clear(name);
    await userEvent.type(name, "Office hours");
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));

    const sent = stub.calls.at(-1)?.body as { name: string; schedule: Record<string, unknown> };
    expect(sent.name).toBe("Office hours");
    expect(sent.schedule).toEqual(EXISTING_WEEK);
  });

  it("opens with the template's own name and note, not an empty form", async () => {
    stubApi({});
    renderWithProviders(<ScheduleTemplateModal nodeId="n1" template={EXISTING} onClose={() => {}} />);

    expect(screen.getByRole("textbox", { name: /^Name/ })).toHaveValue("Business hours");
    expect(screen.getByRole("textbox", { name: /When this is for/ })).toHaveValue("Weekdays");
  });

  it("says the week is unchanged, so nobody looks for a grid that is not there", async () => {
    stubApi({});
    renderWithProviders(<ScheduleTemplateModal nodeId="n1" template={EXISTING} onClose={() => {}} />);
    expect(screen.getByText(/week is unchanged/i)).toBeInTheDocument();
  });
});

describe("the starter week", () => {
  it("is weekdays only", () => {
    const w = starterWeek();
    expect(coveredHours(w)).toBe(45);
    expect(w[5].every((s) => s === "off")).toBe(true);
    expect(w[6].every((s) => s === "off")).toBe(true);
  });
});
