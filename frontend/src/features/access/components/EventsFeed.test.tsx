/**
 * The feed merges three record shapes into one: the REST history row
 * (`{id, occurred_at, raw, door_ref}`), the live SSE frame, and a record that has
 * already been normalised. Every filter and label below reads the normalised
 * keys, so a shape that does not fold correctly silently renders as a blank row.
 *
 * The door index is the case that was actually wrong: it keyed on `door_id`, a
 * v2 field the v3 API does not send, so every door label and the door filter
 * resolved to nothing.
 */
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import type { AccessDoorPublic } from "@/lib/types";
import { paged, stubApi, type ApiStub } from "@/test/apiStub";
import { stubEventSource, type FakeEventSource } from "@/test/eventsource";
import { tokens } from "@/lib/api";
import { renderWithProviders } from "@/test/render";

import EventsFeed from "./EventsFeed";

const DOOR: AccessDoorPublic = {
  id: "door-local-1",
  instance_id: "inst1",
  name: "Server Room",
  remote_ref: "CTRL-7",
  site_id: null,
  floor_id: null,
  zone_id: null,
  is_active: true,
  metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const LOBBY: AccessDoorPublic = { ...DOOR, id: "door-local-2", name: "Lobby", remote_ref: "CTRL-8" };

/** The REST history shape: `id` / `occurred_at` / `raw`, never `event_id`. */
const restRow = {
  id: "e-rest",
  occurred_at: "2026-02-01T10:00:00Z",
  result: "granted",
  door_ref: "CTRL-7",
  cardholder_ref: "ch-1",
  event_type: "AccessGranted",
  raw: { CardCode: "1234" },
};

/** A record that has already been through normalizeEvent once. */
const normalizedRow = {
  event_id: "e-norm",
  timestamp: "2026-02-01T09:00:00Z",
  result: "denied",
  door_id: "CTRL-8",
  raw_payload: { AccessDeniedCode: "4" },
};

let stub: ApiStub;
let ES: typeof FakeEventSource;

beforeEach(() => {
  tokens.set("test-token");
  ES = stubEventSource();
  stub = stubApi({
    "GET /access/instances/inst1/events": paged([restRow, normalizedRow]),
    "GET /access/instances/inst1/cardholders": paged([
      { dto: { UID: "ch-1", FirstName: "Ada", LastName: "Lovelace" } },
    ]),
  });
});

const render = (doors: AccessDoorPublic[] = [DOOR, LOBBY]) =>
  renderWithProviders(<EventsFeed instanceId="inst1" doorIndex={doors} />);

describe("normalising the shapes the feed accepts", () => {
  it("renders a REST history row, whose id and timestamp use the other field names", async () => {
    render();

    // `id`→event_id and `occurred_at`→timestamp; without the fold the row has no
    // key, no time, and no payload to read the card code out of.
    expect(await screen.findAllByText(/Access Granted \(Type 1\)|AccessGranted/)).not.toHaveLength(0);
    expect(screen.getAllByText(/Ada Lovelace/).length).toBeGreaterThan(0);
  });

  it("renders an already-normalised row unchanged — the fold is idempotent", async () => {
    render();

    expect(await screen.findAllByText(/Denied code 4/)).not.toHaveLength(0);
  });

  it("appends a live SSE frame above the fetched history", async () => {
    render();
    await screen.findAllByText(/Ada Lovelace/);

    act(() => {
      ES.last?.open();
      ES.last?.emit("access.event", {
        id: "e-live",
        occurred_at: "2026-02-01T11:00:00Z",
        result: "granted",
        door_ref: "CTRL-8",
        raw: { CardCode: "9999" },
      });
    });

    expect(await screen.findAllByText(/Card 9999 • at Lobby/)).not.toHaveLength(0);
  });

  it("counts a frame that repeats a history row once, not twice", async () => {
    render();
    // Two mentions: the Security Alerts summary line, and the event row itself.
    await waitFor(() => expect(screen.getAllByText(/Ada Lovelace/)).toHaveLength(2));

    act(() => {
      ES.last?.open();
      ES.last?.emit("access.event", { ...restRow });
    });

    // A third would mean the same event_id was merged in as a second row.
    await waitFor(() => expect(screen.getAllByText(/Ada Lovelace/)).toHaveLength(2));
  });
});

describe("resolving a door", () => {
  // The index keys on the CONTROLLER ref the event carries (`remote_ref`), not
  // the local row id — keying on the wrong field left every door unnamed.
  it("names the door from the controller ref the event carries", async () => {
    render();

    expect(await screen.findAllByText(/at Server Room/)).not.toHaveLength(0);
  });

  it("falls back to the local id for a door the mirror has not linked yet", async () => {
    render([{ ...DOOR, remote_ref: null, id: "CTRL-7" }]);

    expect(await screen.findAllByText(/at Server Room/)).not.toHaveLength(0);
  });

  it("prefers the reader name the payload itself carries over the catalog", async () => {
    stub.set({
      "GET /access/instances/inst1/events": paged([
        { ...restRow, raw: { CardCode: "1234", ReaderName: "Server Room — East reader" } },
      ]),
    });

    render();

    expect(await screen.findAllByText(/at Server Room — East reader/)).not.toHaveLength(0);
  });
});

describe("the door filter", () => {
  it("offers each door by name rather than by an opaque ref", async () => {
    render();
    await screen.findAllByText(/at Server Room/);

    expect(screen.getByRole("option", { name: "Server Room" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Lobby" })).toBeInTheDocument();
  });

  it("keeps only the chosen door's events once one is picked", async () => {
    render();
    await screen.findAllByText(/at Server Room/);
    const [, doorSelect] = screen.getAllByRole("combobox");

    await userEvent.selectOptions(doorSelect, "CTRL-7");

    await waitFor(() => expect(screen.queryAllByText(/Denied code 4/)).toHaveLength(0));
    expect(screen.getAllByText(/at Server Room/).length).toBeGreaterThan(0);
  });
});

describe("pausing", () => {
  it("closes the live stream rather than merely hiding what it delivers", async () => {
    render();
    await screen.findAllByText(/at Server Room/);
    const stream = ES.last;

    await userEvent.click(screen.getByRole("button", { name: /pause/i }));

    expect(stream?.closed).toBe(true);
  });
});
