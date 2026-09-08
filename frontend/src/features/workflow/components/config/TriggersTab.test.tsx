/**
 * A trigger is what turns an event into an incident, so a wrong body here means
 * either no incident or the wrong SOP. These pin the create/edit body, the
 * either-or event validation, and the confirm gate on delete.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { httpError, paged, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";
import type { SopPublic, TriggerPublic } from "../../types";

import TriggersTab from "./TriggersTab";

const SOP: SopPublic = {
  sop_id: "sop1",
  name: "Fire alarm response",
  description: null,
  initial_state: null,
  priority: "high",
  trigger_event_types: [],
  sla_hours: null,
  tags: [],
  escalation_rules: [],
  version: 1,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const trigger = (over: Partial<TriggerPublic> = {}): TriggerPublic => ({
  trigger_id: "tr1",
  name: "Fire alarm",
  description: null,
  sop_id: "sop1",
  event_source: "ingest",
  event_type: "fire.alarm",
  conditions: [],
  dedup: { strategy: "per_event_type", window_seconds: 300 },
  priority: "high",
  auto_assign: null,
  assign_users: [],
  enabled: true,
  last_fired_at: null,
  fire_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const FIRE = trigger();
const INTRUSION = trigger({ trigger_id: "tr2", name: "Intrusion", event_type: "door.forced" });

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /workflow/triggers": paged([FIRE, INTRUSION]),
    "GET /workflow/sops": paged([SOP]),
    "GET /auth/users": paged([]),
    "POST /workflow/triggers": FIRE,
    "PATCH /workflow/triggers/*": FIRE,
    "DELETE /workflow/triggers/*": {},
  });
});

describe("a failed load", () => {
  it("reports the failure instead of claiming there are no triggers", async () => {
    stub.set({ "GET /workflow/triggers": () => httpError(503, "Workflow service unreachable") });

    renderWithProviders(<TriggersTab />);

    expect(await screen.findByText("Workflow service unreachable")).toBeInTheDocument();
    expect(screen.queryByText(/no triggers yet/i)).not.toBeInTheDocument();
  });
});

describe("which trigger is open", () => {
  it("opens the first one while browsing, with no explicit choice made", async () => {
    renderWithProviders(<TriggersTab />);

    expect(await screen.findAllByText("Fire alarm")).not.toHaveLength(0);
    expect(screen.queryByText(/no trigger selected/i)).not.toBeInTheDocument();
  });

  it("does not fall back to the first row while a new trigger is being created", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");

    await userEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    // A create form pre-filled from an unrelated row is worse than a blank one.
    expect(await screen.findByPlaceholderText("e.g. Fire alarm → Fire SOP")).toHaveValue("");
  });
});

describe("deleting a trigger", () => {
  it("asks for confirmation and sends nothing until it is given", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");

    await userEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(await screen.findByText(/delete "fire alarm"\?/i)).toBeInTheDocument();
    expect(stub.matching("DELETE /workflow/triggers/*")).toHaveLength(0);
  });

  it("deletes the trigger that was open once confirmed", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getAllByText("Intrusion")[0]);

    await userEvent.click(await screen.findByRole("button", { name: /delete/i }));
    await userEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);

    await waitFor(() => expect(stub.matching("DELETE /workflow/triggers/*")).toHaveLength(1));
    expect(stub.matching("DELETE /workflow/triggers/*")[0].url).toBe("/workflow/triggers/tr2");
  });
});

describe("enabling and disabling", () => {
  // Enable/disable are separate action routes, not a PATCH of `enabled`.
  it("goes through the disable action route for a trigger that is on", async () => {
    stub.set({ "POST /workflow/triggers/*": FIRE });
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");

    await userEvent.click(screen.getByRole("button", { name: "Enabled" }));

    await waitFor(() =>
      expect(stub.matching("POST /workflow/triggers/*").map((c) => c.url)).toContain(
        "/workflow/triggers/tr1/disable"
      )
    );
  });
});

describe("the trigger form", () => {
  it("requires a name and a target SOP before anything is sent", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    await userEvent.click(await screen.findByRole("button", { name: /create trigger/i }));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(screen.getByText("Target SOP is required")).toBeInTheDocument();
    expect(stub.matching("POST /workflow/triggers")).toHaveLength(0);
  });

  // Neither field is individually required, but a trigger matching everything
  // from every source would turn every event into an incident.
  it("insists on an event type or an event source, not neither", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm → Fire SOP"), "Flood");
    await userEvent.click(screen.getByRole("button", { name: /^target sop$/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Fire alarm response" }));
    await userEvent.click(screen.getByRole("button", { name: /create trigger/i }));

    expect(await screen.findByText(/specify event type, event source, or both/i)).toBeInTheDocument();
    expect(stub.matching("POST /workflow/triggers")).toHaveLength(0);
  });

  it("omits the priority override entirely when the SOP default is kept", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm → Fire SOP"), "Flood");
    await userEvent.type(screen.getByPlaceholderText("e.g. fire.alarm or *"), "flood.detected");
    await userEvent.click(screen.getByRole("button", { name: /^target sop$/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Fire alarm response" }));
    await userEvent.click(screen.getByRole("button", { name: /create trigger/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/triggers")).toHaveLength(1));
    const body = stub.body("POST /workflow/triggers") || {};
    // `priority` is a non-null enum on create; sending "" is a 422, and sending a
    // real value would override the SOP's own default.
    expect(body).not.toHaveProperty("priority");
    expect(body).toMatchObject({
      name: "Flood",
      description: null,
      event_source: "",
      event_type: "flood.detected",
      sop_id: "sop1",
      assign_users: [],
      enabled: true,
      conditions: [],
      dedup: { strategy: "per_event_type", window_seconds: 300 },
    });
  });

  it("sends a condition as the field/operator/value shape the matcher reads", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getByRole("button", { name: /new trigger/i }));

    await userEvent.type(await screen.findByPlaceholderText("e.g. Fire alarm → Fire SOP"), "Flood");
    await userEvent.type(screen.getByPlaceholderText("e.g. fire.alarm or *"), "flood.detected");
    await userEvent.click(screen.getByRole("button", { name: /^target sop$/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Fire alarm response" }));

    await userEvent.click(screen.getByRole("button", { name: /add condition/i }));
    await userEvent.type(screen.getByPlaceholderText("payload.path"), "payload.zone");
    await userEvent.type(screen.getByPlaceholderText("value"), "basement");
    await userEvent.click(screen.getByRole("button", { name: /create trigger/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/triggers")).toHaveLength(1));
    expect((stub.body("POST /workflow/triggers") || {}).conditions).toEqual([
      { field: "payload.zone", operator: "eq", value: "basement" },
    ]);
  });

  it("edits through the trigger's own id, not the row that happened to be first", async () => {
    renderWithProviders(<TriggersTab />);
    await screen.findAllByText("Fire alarm");
    await userEvent.click(screen.getAllByText("Intrusion")[0]);
    await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));

    await userEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(stub.matching("PATCH /workflow/triggers/*")).toHaveLength(1));
    expect(stub.matching("PATCH /workflow/triggers/*")[0].url).toBe("/workflow/triggers/tr2");
  });
});
