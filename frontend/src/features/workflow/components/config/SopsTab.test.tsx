/**
 * The SOPs tab is where the master/detail selection rule is subtlest: the first
 * row is a fallback ONLY while browsing, because falling back during create/edit
 * would silently swap the record under the form the operator is filling in.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";
import type { SopPublic } from "../../types";

import SopsTab from "./SopsTab";

const sop = (over: Partial<SopPublic> = {}): SopPublic => ({
  sop_id: "sop1",
  name: "Fire alarm response",
  description: "Evacuate and verify",
  initial_state: null,
  priority: "high",
  trigger_event_types: [],
  sla_hours: 2,
  tags: [],
  escalation_rules: [],
  version: 1,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const FIRE = sop();
const INTRUSION = sop({ sop_id: "sop2", name: "Intrusion response", priority: "critical" });

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /workflow/sops": paged([FIRE, INTRUSION]),
    "GET /workflow/triggers": paged([]),
    "GET /workflow/sops/*": [],
    "POST /workflow/sops": FIRE,
    "PATCH /workflow/sops/*": FIRE,
    "DELETE /workflow/sops/*": {},
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming there are no SOPs", async () => {
    stub.set({ "GET /workflow/sops": () => httpError(503, "Workflow service unreachable") });

    renderWithProviders(<SopsTab />);

    expect(await screen.findByText("Workflow service unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/no sops yet/i)).not.toBeInTheDocument();
  });
});

describe("which SOP is open", () => {
  it("opens the first one while browsing, with no explicit choice made", async () => {
    renderWithProviders(<SopsTab />);

    expect(await screen.findAllByText("Fire alarm response")).not.toHaveLength(0);
    expect(screen.queryByText(/no sop selected/i)).not.toBeInTheDocument();
  });

  // The fallback is deliberately mode-scoped: the create form owns the pane, and
  // must not be handed the record of whichever row happened to be selected.
  it("opens a blank create form rather than the SOP that was open", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");

    await userEvent.click(screen.getByRole("button", { name: /new sop/i }));

    expect(await screen.findAllByText("Create SOP")).not.toHaveLength(0);
    expect(screen.getByPlaceholderText("e.g. Fire alarm response")).toHaveValue("");
  });

  it("keeps an explicit choice across a refetch of the list", async () => {
    const { client } = renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");

    await userEvent.click(screen.getAllByText("Intrusion response")[0]);
    await client.invalidateQueries({ queryKey: ["wf-sops"] });
    await waitFor(() => expect(stub.matching("GET /workflow/sops").length).toBeGreaterThan(1));

    expect(screen.getAllByText("Intrusion response").length).toBeGreaterThan(1);
  });
});

describe("deleting a SOP", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/states\/transitions/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /workflow/sops/*")).toHaveLength(0);
  });

  it("deletes the SOP that was open once confirmed", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");
    await userEvent.click(screen.getAllByText("Intrusion response")[0]);

    await userEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() => expect(stub.matching("DELETE /workflow/sops/*")).toHaveLength(1));
    expect(stub.matching("DELETE /workflow/sops/*")[0].url).toBe("/workflow/sops/sop2");
  });
});

describe("the SOP form", () => {
  it("refuses to create a nameless SOP before the network sees it", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");
    await userEvent.click(screen.getByRole("button", { name: /new sop/i }));

    await userEvent.click(await screen.findByRole("button", { name: /create sop/i }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(stub.matching("POST /workflow/sops")).toHaveLength(0);
  });

  it("refuses escalation rules that are not valid JSON rather than posting them", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");
    await userEvent.click(screen.getByRole("button", { name: /new sop/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm response"), "Flood");
    const rules = screen.getByPlaceholderText(/after_hours/);
    await userEvent.clear(rules);
    await userEvent.type(rules, "not json");
    await userEvent.click(screen.getByRole("button", { name: /create sop/i }));

    expect(await screen.findByText(/must be valid json/i)).toBeInTheDocument();
    expect(stub.matching("POST /workflow/sops")).toHaveLength(0);
  });

  it("sends a null SLA rather than an empty string when none was given", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");
    await userEvent.click(screen.getByRole("button", { name: /new sop/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm response"), "Flood");
    await userEvent.click(screen.getByRole("button", { name: /create sop/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/sops")).toHaveLength(1));
    const body = stub.body("POST /workflow/sops") || {};
    // `Number("")` is 0 — an SLA of zero hours is not "no SLA".
    expect(body.sla_hours).toBeNull();
    expect(body).toMatchObject({
      name: "Flood",
      description: null,
      priority: "medium",
      tags: [],
      trigger_event_types: [],
      escalation_rules: [],
      is_active: true,
    });
  });

  it("splits the comma-separated lists into arrays the API can store", async () => {
    renderWithProviders(<SopsTab />);
    await screen.findAllByText("Fire alarm response");
    await userEvent.click(screen.getByRole("button", { name: /new sop/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm response"), "Flood");
    await userEvent.type(screen.getByPlaceholderText("alarm, after-hours"), "alarm, ,after-hours");
    await userEvent.click(screen.getByRole("button", { name: /create sop/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/sops")).toHaveLength(1));
    expect((stub.body("POST /workflow/sops") || {}).tags).toEqual(["alarm", "after-hours"]);
  });
});
