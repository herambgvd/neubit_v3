/**
 * VMS → Linkage. The rules that turn an event into an action — record this
 * camera, pop it on the wall, drive a relay, send a notification.
 *
 * The thing worth testing here is not the form. It is whether the screen can tell
 * an operator that the automation IS RUNNING: the engine writes a fire-audit row
 * for every match, including what each action returned, and until now no screen
 * read it. A rule that matches and whose action the recorder refuses looked
 * exactly like a rule that works.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import LinkageRulesPage from "./LinkageRules";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const RULES = {
  items: [
    {
      id: "r1",
      name: "gate-motion-record",
      trigger_event_type: "motion",
      camera_scope: { all: true },
      cooldown_seconds: 30,
      is_active: true,
      actions: [{ type: "start_recording", config: {} }],
    },
    {
      id: "r2",
      name: "door-forced-popup",
      trigger_event_type: "access_door_forced",
      camera_scope: {},
      cooldown_seconds: 0,
      is_active: false,
      actions: [{ type: "popup", config: {} }],
    },
  ],
  total: 2,
};

const FIRES = {
  items: [
    {
      id: "f1",
      rule_id: "r1",
      trigger_event_type: "motion",
      camera_id: "cam-9",
      actions_result: [{ type: "start_recording", ok: true, detail: "recording started" }],
      fired_at: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
  total: 1,
};

let stub: ApiStub;

function stubAll(over: Record<string, unknown> = {}) {
  stub = stubApi({
    "GET /vms/linkage-rules": RULES,
    "GET /vms/linkage-fires": FIRES,
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/camera-groups": { items: [], total: 0 },
    "GET /vms/federation/cameras": { items: [], unreachable: [] },
    ...over,
  });
  return stub;
}

beforeEach(() => stubAll());

describe("the rule list", () => {
  it("opens the first rule rather than an empty pane", async () => {
    renderWithProviders(<LinkageRulesPage />);

    expect(await screen.findAllByText("gate-motion-record")).not.toHaveLength(0);
    expect(screen.queryByText(/no rule selected/i)).toBeNull();
  });

  it("reports a failed load instead of an estate with no automation", async () => {
    // "No linkage rules yet" and "we could not list them" are opposite claims.
    stubAll({ "GET /vms/linkage-rules": () => httpError(503, "linkage is unavailable") });
    renderWithProviders(<LinkageRulesPage />);

    expect(await screen.findByText(/linkage is unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText(/no linkage rules yet/i)).toBeNull();
  });

  it("counts active and inactive separately", async () => {
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    expect(screen.getByTitle("active")).toHaveTextContent("1");
    expect(screen.getByTitle("inactive")).toHaveTextContent("1");
  });
});

describe("whether the rule is actually working", () => {
  it("reads this rule's own fire log", async () => {
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    await waitFor(() => expect(stub.matching("GET /vms/linkage-fires")).not.toHaveLength(0));
    // Scoped to the open rule — a shared feed would report another rule's
    // activity as this one's.
    expect(stub.matching("GET /vms/linkage-fires")[0].search.get("rule_id")).toBe("r1");
    expect(await screen.findByText("cam-9")).toBeInTheDocument();
  });

  it("shows what failed when an action was refused", async () => {
    // The rule MATCHED and the recorder said no. Without this the screen shows a
    // healthy-looking rule and the operator has nothing to chase.
    stubAll({
      "GET /vms/linkage-fires": {
        items: [
          {
            id: "f2",
            rule_id: "r1",
            trigger_event_type: "motion",
            camera_id: "cam-9",
            actions_result: [
              { type: "start_recording", ok: false, detail: "recorder unavailable: timeout" },
            ],
            fired_at: new Date().toISOString(),
          },
        ],
      },
    });
    renderWithProviders(<LinkageRulesPage />);

    expect(await screen.findByText(/recorder unavailable: timeout/i)).toBeInTheDocument();
  });

  it("says an inactive rule cannot fire, rather than that it never has", async () => {
    // Two different facts. A rule armed this morning has simply not fired yet.
    stubAll({ "GET /vms/linkage-fires": { items: [] } });
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    expect(await screen.findByText(/fires when a matching event arrives/i)).toBeInTheDocument();

    await userEvent.click(screen.getByText("door-forced-popup"));
    expect(await screen.findByText(/it is inactive, so it cannot fire/i)).toBeInTheDocument();
  });

  it("keeps the fire log out of the way when it cannot be read", async () => {
    stubAll({ "GET /vms/linkage-fires": () => httpError(403, "forbidden") });
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    expect(await screen.findByText(/forbidden|couldn.t read the fire log/i)).toBeInTheDocument();
    // The rule itself still renders — one unreadable feed is not a broken screen.
    expect(screen.getByText(/camera scope/i)).toBeInTheDocument();
  });
});

describe("the camera scope picker", () => {
  it("offers the recorder's cameras, not just VMS-owned rows", async () => {
    // Single ownership — the normal estate — has no VMS camera rows at all, so
    // this list read `/vms/cameras` and offered NOTHING on a site running three
    // cameras. The only scope a rule could be given was "any camera".
    stubAll({
      "GET /vms/cameras": { items: [], total: 0 },
      "GET /vms/federation/cameras": {
        items: [
          { id: "fed:n1:c1", name: "Channel 1", status: "online", node_id: "n1", node_name: "rec-a" },
          { id: "fed:n1:c2", name: "Channel 2", status: "online", node_id: "n1", node_name: "rec-a" },
        ],
        unreachable: [],
      },
    });
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    await userEvent.click(screen.getByRole("button", { name: /new rule/i }));
    await userEvent.click(await screen.findByRole("button", { name: /applies to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /specific cameras/i }));

    expect(await screen.findByText("Channel 1")).toBeInTheDocument();
    expect(screen.getByText("Channel 2")).toBeInTheDocument();
    expect(screen.queryByText(/^No cameras$/)).toBeNull();
  });

  it("says a recorder is not answering rather than that there are no cameras", async () => {
    stubAll({
      "GET /vms/cameras": { items: [], total: 0 },
      "GET /vms/federation/cameras": () => httpError(503, "federation is unreachable"),
    });
    renderWithProviders(<LinkageRulesPage />);
    await screen.findAllByText("gate-motion-record");

    await userEvent.click(screen.getByRole("button", { name: /new rule/i }));
    await userEvent.click(await screen.findByRole("button", { name: /applies to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /specific cameras/i }));

    expect(await screen.findByText(/recorder is not answering/i)).toBeInTheDocument();
  });
});
