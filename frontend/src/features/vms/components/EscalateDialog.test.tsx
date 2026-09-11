/**
 * ESCALATION — the door between the two surfaces.
 *
 * Events is the ledger of what the recorders reported; Alarms is the work a
 * person must do about one. This dialog is how an operator moves a row from the
 * first to the second, and three things about it are load-bearing:
 *
 *   1. THE ENVELOPE. The backend derives an incident's `event_source` and
 *      `source_event_id` from `{source, payload.event_id}`. Send a different
 *      shape and the incident still saves — it just arrives with no camera, no
 *      link back to the event, and outside the Source filter. Nothing fails
 *      loudly, which is exactly why it is pinned here.
 *   2. THE RANKING. The SOP that names this event's type comes first and comes
 *      pre-selected, so the ordinary case is one click.
 *   3. THE DEAD END. A deployment with no SOPs cannot raise an alarm at all.
 *      The dialog has to say so and offer the way out, not show an empty list.
 */
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithProviders } from "@/test/render";
import { stubApi, type ApiStub } from "@/test/apiStub";
import { normalizeVmsEvent, type NormalizedVmsEvent } from "../eventLib";
import type { SopPublic } from "@/features/workflow/types";
import EscalateDialog, {
  anchorEvent,
  automationRule,
  escalationEnvelope,
  existingRuleFor,
  rankSops,
} from "./EscalateDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

let allowed = true;
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: () => allowed, hasModule: () => true }),
}));

const EVENT = normalizeVmsEvent({
  id: "row-1",
  event_id: "ev-1",
  camera_id: "cam-9",
  event_type: "tamper",
  severity: "alarm",
  occurred_at: "2026-09-10T04:42:19Z",
  raw: {},
  acknowledged: false,
}) as NormalizedVmsEvent;

const sop = (over: Partial<SopPublic> = {}): SopPublic => ({
  sop_id: `s-${Math.random().toString(36).slice(2)}`,
  name: "General alarm",
  description: "For anything without a procedure of its own.",
  initial_state: "st-1",
  priority: "medium" as const,
  trigger_event_types: [],
  sla_hours: 4,
  tags: [],
  escalation_rules: [],
  version: 1,
  is_active: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...over,
});

const trigger = (over: Record<string, unknown> = {}) => ({
  trigger_id: `t-${Math.random().toString(36).slice(2)}`,
  name: "Auto: Tamper",
  description: null,
  sop_id: "s1",
  event_source: "vision",
  event_type: "tamper",
  conditions: [],
  dedup: {},
  priority: "medium",
  auto_assign: null,
  assign_users: [],
  enabled: true,
  last_fired_at: null,
  fire_count: 0,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  ...over,
});

function stubWith(sops: unknown[], over: Record<string, unknown> = {}): ApiStub {
  return stubApi({
    "GET /vms/cameras": { items: [], total: 0 },
    "GET /vms/federation/cameras": {
      items: [
        { id: "cam-9", name: "Channel 2", node_id: "n1", node_name: "recorder-a", status: "online" },
      ],
      total: 1,
    },
    // The estate's placement index: which floor of which site a camera is pinned
    // to. `fed:n1:cam-9` is the id a placement is keyed on.
    "GET /device-placements/index": {
      items: [
        { device_id: "fed:n1:cam-9", device_type: "camera", site_id: "site-7", floor_id: "f1" },
      ],
      count: 1,
    },
    "GET /workflow/sops": { items: sops, total: sops.length },
    "GET /workflow/triggers": { items: [], total: 0 },
    "POST /workflow/instances": { instance_id: "inc-1", name: "Tamper · Channel 2" },
    "POST /workflow/triggers": trigger(),
    "POST /workflow/sops/starters": { items: [sop()], created: 4, skipped: [] },
    ...over,
  });
}

const open = (props: Record<string, unknown> = {}) =>
  renderWithProviders(
    <EscalateDialog open onClose={() => {}} events={[EVENT]} cameraName="Channel 2" {...props} />,
  );

describe("the envelope it sends", () => {
  it("carries the source and the event id the backend reads", () => {
    const env = escalationEnvelope([EVENT], {
      cameraName: "Channel 2",
      recorderName: "recorder-a",
      nodeId: "n1",
    }) as { source: string; payload: Record<string, unknown> };

    expect(env.source).toBe("vision");
    // `source_event_id` is derived from exactly this field. Rename it and the
    // link back from the event goes quietly dead.
    expect(env.payload.event_id).toBe("ev-1");
    expect(env.payload.camera_id).toBe("cam-9");
    expect(env.payload.occurred_at).toBe("2026-09-10T04:42:19Z");
    expect(env.payload.node_name).toBe("recorder-a");
  });
});

describe("choosing a procedure", () => {
  it("puts the one that answers this event type first", () => {
    const generic = sop({ sop_id: "generic", name: "General alarm" });
    const tamper = sop({ sop_id: "tamper", name: "Camera tamper", trigger_event_types: ["tamper"] });
    expect(rankSops([generic, tamper], "tamper").map((s) => s.sop_id)).toEqual(["tamper", "generic"]);
    // With no match, the server's order stands rather than being shuffled.
    expect(rankSops([generic, tamper], "motion").map((s) => s.sop_id)).toEqual(["generic", "tamper"]);
  });

  it("pre-selects the match, so the common case is one click", async () => {
    const stub = stubWith([
      sop({ sop_id: "generic", name: "General alarm" }),
      sop({ sop_id: "tamper-sop", name: "Camera tamper", trigger_event_types: ["tamper"] }),
    ]);
    open();

    expect(await screen.findByText(/matches this event/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/instances")).toHaveLength(1));
    expect(stub.body("POST /workflow/instances")?.sop_id).toBe("tamper-sop");
  });

  it("carries WHERE the alarm is, not only which camera", async () => {
    // An incident with no site cannot be placed on the estate map and slips past
    // every site-scoped filter. The camera's own site_id is the RECORDER, so the
    // answer comes from where somebody actually pinned that camera.
    const stub = stubWith([sop({ sop_id: "s1" })]);
    open();

    await screen.findByText("General alarm");
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/instances")).toHaveLength(1));
    expect(stub.body("POST /workflow/instances")?.site_id).toBe("site-7");
  });

  it("leaves the site null when nobody has placed that camera", async () => {
    // Null is a real answer. Guessing a site would put the alarm at a building it
    // is not in, which is worse than an unplaced pin.
    const stub = stubWith([sop({ sop_id: "s1" })], {
      "GET /device-placements/index": { items: [], count: 0 },
    });
    open();

    await screen.findByText("General alarm");
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/instances")).toHaveLength(1));
    expect(stub.body("POST /workflow/instances")?.site_id).toBeNull();
  });

  it("sends the whole envelope with the incident", async () => {
    const stub = stubWith([sop({ sop_id: "only" })]);
    open({ recorderName: "recorder-a", nodeId: "n1" });

    await screen.findByText("General alarm");
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/instances")).toHaveLength(1));
    const body = stub.body("POST /workflow/instances") as Record<string, unknown>;
    const env = body.trigger_data as { source: string; payload: Record<string, unknown> };
    expect(env.source).toBe("vision");
    expect(env.payload.event_id).toBe("ev-1");
    expect(body.event_id).toBe("ev-1");
    expect(body.event_type).toBe("tamper");
  });
});

describe("a system with no procedures", () => {
  it("says so and offers to install the starters, instead of an empty list", async () => {
    const stub = stubWith([]);
    open();

    expect(await screen.findByText(/no procedures yet/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /install the starter playbooks/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/sops/starters")).toHaveLength(1));
  });

  it("does not offer an install an operator is not allowed to do", async () => {
    allowed = false;
    stubWith([]);
    open();

    expect(await screen.findByText(/no procedures yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /install the starter/i })).toBeNull();
    expect(screen.getByText(/ask an administrator/i)).toBeInTheDocument();
    allowed = true;
  });
});


describe("making it automatic", () => {
  /**
   * The correlation engine has been listening the whole time; what it lacks is a
   * rule. This is where rules come from — a person who has just decided, about a
   * real event — instead of a configuration session nobody books.
   */
  it("offers the rule once the alarm exists, not before", async () => {
    stubWith([sop({ sop_id: "s1" })]);
    open();

    await screen.findByText("General alarm");
    expect(screen.queryByText(/do this by itself/i)).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));
    expect(await screen.findByText(/do this by itself/i)).toBeInTheDocument();
  });

  it("scopes the rule to one camera, or to the estate", () => {
    const s = sop({ sop_id: "s1", priority: "high" });
    const one = automationRule(EVENT, s, "camera", "Channel 2");
    expect(one.event_type).toBe("tamper");
    expect(one.conditions).toEqual([{ field: "payload.camera_id", operator: "eq", value: "cam-9" }]);
    expect(one.priority).toBe("high");
    expect(one.name).toContain("Channel 2");

    const all = automationRule(EVENT, s, "estate", "Channel 2");
    expect(all.conditions).toEqual([]);
    // A burst must not become forty incidents.
    expect(all.dedup?.window_seconds).toBe(3600);
  });

  it("creates the rule the operator chose", async () => {
    const stub = stubWith([sop({ sop_id: "s1" })]);
    open();

    await screen.findByText("General alarm");
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));
    await userEvent.click(await screen.findByRole("button", { name: /only channel 2/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/triggers")).toHaveLength(1));
    const body = stub.body("POST /workflow/triggers") as Record<string, unknown>;
    expect(body.sop_id).toBe("s1");
    expect(body.event_type).toBe("tamper");
    expect(body.conditions).toEqual([
      { field: "payload.camera_id", operator: "eq", value: "cam-9" },
    ]);
  });

  it("says so instead when a rule already covers this event", async () => {
    stubWith([sop({ sop_id: "s1" })], {
      "GET /workflow/triggers": { items: [trigger({ name: "Auto: Tamper (any camera)" })], total: 1 },
    });
    open();

    await screen.findByText("General alarm");
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    expect(await screen.findByText(/already happens automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /every camera/i })).toBeNull();
  });

  it("does not count a rule for a different camera as coverage", () => {
    const other = trigger({
      conditions: [{ field: "payload.camera_id", operator: "eq", value: "cam-OTHER" }],
    });
    expect(existingRuleFor([other] as never, EVENT)).toBeNull();

    const mine = trigger({
      conditions: [{ field: "payload.camera_id", operator: "eq", value: "cam-9" }],
    });
    expect(existingRuleFor([mine] as never, EVENT)).not.toBeNull();
  });

  it("ignores a rule somebody switched off", () => {
    const off = trigger({ enabled: false });
    expect(existingRuleFor([off] as never, EVENT)).toBeNull();
  });
});


describe("a burst becomes one alarm", () => {
  /**
   * Twenty-nine motions from one camera are ONE thing that happened. Raising
   * twenty-nine alarms makes a queue nobody reads, and acknowledging them one at
   * a time is the work the console should be doing.
   */
  const at = (iso: string, id: string) =>
    normalizeVmsEvent({
      id,
      event_id: id,
      camera_id: "cam-9",
      event_type: "motion",
      severity: "alarm",
      occurred_at: iso,
      raw: {},
      acknowledged: false,
    }) as NormalizedVmsEvent;

  const BURST = [
    at("2026-09-10T04:50:00Z", "e-late"),
    at("2026-09-10T04:40:00Z", "e-first"),
    at("2026-09-10T04:45:00Z", "e-mid"),
  ];

  it("anchors on where the burst STARTED, not on what was clicked last", () => {
    // The alarm card's playback opens at this instant. The beginning is the part
    // worth watching; the newest is only where the operator happened to be.
    expect(anchorEvent(BURST).event_id).toBe("e-first");
  });

  it("claims every event in the burst, so none of them can be escalated again", () => {
    const env = escalationEnvelope(BURST) as { payload: Record<string, unknown> };
    expect(env.payload.event_id).toBe("e-first");
    expect(env.payload.event_ids).toEqual(["e-late", "e-first", "e-mid"]);
    expect(env.payload.event_count).toBe(3);
    expect((env.payload as Record<string, unknown>).last_occurred_at).toBe("2026-09-10T04:50:00Z");
  });

  it("says nothing about a burst when there is only one event", () => {
    // A one-item list and a count of 1 is noise in every payload anyone reads.
    const env = escalationEnvelope([EVENT]) as { payload: Record<string, unknown> };
    expect(env.payload.event_ids).toBeUndefined();
    expect(env.payload.event_count).toBeUndefined();
  });

  it("names the alarm for the whole selection", async () => {
    const stub = stubWith([sop({ sop_id: "s1" })]);
    renderWithProviders(
      <EscalateDialog open onClose={() => {}} events={BURST} cameraName="Channel 1" />,
    );

    await screen.findByText("General alarm");
    expect(screen.getByText("3 events")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /raise alarm/i }));

    await waitFor(() => expect(stub.matching("POST /workflow/instances")).toHaveLength(1));
    expect(stub.body("POST /workflow/instances")?.name).toBe("Motion · Channel 1 (3 events)");
  });

  it("warns when the selection is not one incident", async () => {
    const mixed = [
      BURST[0],
      normalizeVmsEvent({
        id: "other", event_id: "other", camera_id: "cam-OTHER", event_type: "tamper",
        severity: "alarm", occurred_at: "2026-09-10T04:41:00Z", raw: {}, acknowledged: false,
      }) as NormalizedVmsEvent,
    ];
    stubWith([sop({ sop_id: "s1" })]);
    renderWithProviders(
      <EscalateDialog open onClose={() => {}} events={mixed} cameraName="Channel 1" />,
    );

    expect(await screen.findByText(/mixed selection/i)).toBeInTheDocument();
  });
});

/**
 * SORTING A TIMESTAMP AS TEXT WORKS UNTIL IT DOES NOT.
 *
 * ISO-8601 strings compare correctly character by character only while every one
 * has the same shape. The recorder's do not: its fractional seconds are trimmed,
 * so "…56.4Z" and "…56.42Z" differ in length — and 'Z' (90) outranks '2' (50),
 * which puts the EARLIER instant last. That is the value carried as
 * `last_occurred_at`, and the field an operator reads to decide whether a burst
 * is still running.
 */
function ev(occurred_at: string, id: string) {
  return { id, event_id: id, occurred_at, camera_id: "cam-1", event_type: "tamper", severity: "critical" } as never;
}

describe("the last time a burst was seen", () => {
  it("picks the latest instant when the precisions differ", () => {
    // Sorted as text, "…56.4Z" wins and the envelope reports an instant 20ms
    // before the real last event.
    const env = escalationEnvelope([ev("2026-09-11T10:00:56.4Z", "a"), ev("2026-09-11T10:00:56.42Z", "b")]);
    expect((env.payload as Record<string, unknown>).last_occurred_at).toBe("2026-09-11T10:00:56.42Z");
  });

  it("still picks the latest when the precisions match", () => {
    const env = escalationEnvelope([ev("2026-09-11T10:00:01Z", "a"), ev("2026-09-11T10:00:09Z", "b")]);
    expect((env.payload as Record<string, unknown>).last_occurred_at).toBe("2026-09-11T10:00:09Z");
  });

  it("is unbothered by the order they arrive in", () => {
    const env = escalationEnvelope([ev("2026-09-11T10:00:09Z", "b"), ev("2026-09-11T10:00:01Z", "a")]);
    expect((env.payload as Record<string, unknown>).last_occurred_at).toBe("2026-09-11T10:00:09Z");
  });
});
