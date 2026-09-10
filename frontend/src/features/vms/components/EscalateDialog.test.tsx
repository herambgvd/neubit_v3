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
import EscalateDialog, { escalationEnvelope, rankSops } from "./EscalateDialog";

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

function stubWith(sops: unknown[], over: Record<string, unknown> = {}): ApiStub {
  return stubApi({
    "GET /workflow/sops": { items: sops, total: sops.length },
    "POST /workflow/instances": { instance_id: "inc-1", name: "Tamper · Channel 2" },
    "POST /workflow/sops/starters": { items: [sop()], created: 4, skipped: [] },
    ...over,
  });
}

const open = (props: Record<string, unknown> = {}) =>
  renderWithProviders(
    <EscalateDialog open onClose={() => {}} event={EVENT} cameraName="Channel 2" {...props} />,
  );

describe("the envelope it sends", () => {
  it("carries the source and the event id the backend reads", () => {
    const env = escalationEnvelope(EVENT, {
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
