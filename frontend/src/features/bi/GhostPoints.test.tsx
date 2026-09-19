/**
 * DUPLICATES — one screen, one way to work it: a sensor at a time, its copies
 * side by side, keep one.
 *
 * The rule under all of it: a bulk answer may only reach a question the DATA
 * already settled. So:
 *
 *   • the sweep posts `mode: "auto"` and names only the sensors where exactly
 *     one copy is still reporting — it can never reach one that needs a person;
 *   • a sensor that needs a person is a QUESTION, and the screen recommends
 *     nothing: it states what is true of each copy;
 *   • deleting is the third answer, not the first — behind the gateway's key
 *     and a confirmation that names what it destroys;
 *   • an archived copy reporting again is surfaced with the action that settles
 *     it, never folded back into the queue;
 *   • a viewer without `bi.manage` reads the questions and is offered no write.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { iot } from "@/features/iot/api";

import GhostPoints from "./GhostPoints";
import { bi } from "./api";

const canRef = { fn: (_p: string) => true };
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));

interface Member {
  point_id: string;
  first_seen_at?: string | null;
  last_seen_at: string | null;
  readings?: number | null;
  unit: string | null;
  fresh: boolean;
  has_role: boolean;
  role: string | null;
}

const member = (over: Partial<Member> & { point_id: string }): Member => ({
  first_seen_at: null,
  last_seen_at: "2026-09-19T09:00:00Z",
  readings: null,
  unit: null,
  fresh: false,
  has_role: false,
  role: null,
  ...over,
});

/** Settled by the data: exactly one copy still reporting. */
const autoGroup = {
  device_tag: "1F-DB",
  point_tag: "KWH",
  category: "energy",
  mode: "auto",
  survivor_point_id: "p-new",
  members: [
    member({ point_id: "p-new", fresh: true }),
    member({ point_id: "p-old", last_seen_at: "2026-08-02T09:00:00Z" }),
  ],
};

/** Two copies, neither reporting — the case 45 of the live estate's 46 are in,
 *  and the one the old screen offered two uuids for. */
const twoDead = {
  device_tag: "4FKC2",
  point_tag: "IWT",
  category: "hvac",
  mode: "manual",
  survivor_point_id: null,
  members: [
    member({
      point_id: "m-old",
      first_seen_at: "2026-01-02T11:05:00Z",
      last_seen_at: "2026-09-11T16:16:00Z",
      readings: 331_440,
    }),
    member({
      point_id: "m-new",
      first_seen_at: "2026-06-03T09:40:00Z",
      last_seen_at: "2026-09-11T17:12:00Z",
      readings: 146_220,
    }),
  ],
};

function worklist(over: Record<string, unknown> = {}) {
  const groups = (over.groups as any[]) ?? [autoGroup, twoDead];
  return vi.spyOn(bi, "ghosts").mockResolvedValue({
    groups,
    total: groups.length,
    auto: groups.filter((g) => g.mode === "auto").length,
    manual: groups.filter((g) => g.mode === "manual").length,
    fresh_minutes: 15,
    resurrected: [],
    ...over,
  });
}

const renderPage = () => {
  renderWithProviders(<GhostPoints />);
  return userEvent.setup();
};

const settledOk = {
  groups_collapsed: 1,
  points_retired: 1,
  roles_migrated: 0,
  roles_discarded: 0,
  groups_skipped: 0,
  skipped: [],
};

beforeEach(() => {
  canRef.fn = () => true;
});

// ── the sweep ────────────────────────────────────────────────────────────────

describe("the sweep", () => {
  it("names only the sensors the data already settled", async () => {
    worklist();
    renderPage();

    expect(await screen.findByText(/1 more needs no decision/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settle it" })).toBeInTheDocument();
  });

  it("asks the server for the automatic mode, never for a sensor that needs a person", async () => {
    worklist();
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue(settledOk);
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: "Settle it" }));

    await waitFor(() => expect(collapse).toHaveBeenCalledWith({ mode: "auto" }));
    expect(JSON.stringify(collapse.mock.calls)).not.toContain("IWT");
  });

  it("is not offered at all when nothing is sweepable", async () => {
    worklist({ groups: [twoDead] });
    renderPage();

    await screen.findByRole("heading", { name: "IWT" });
    expect(screen.queryByText(/needs no decision/)).not.toBeInTheDocument();
  });
});

// ── the walk ─────────────────────────────────────────────────────────────────

describe("the walk", () => {
  it("heads each question with the sensor itself, and nothing above it", async () => {
    worklist();
    renderPage();

    expect(await screen.findByRole("heading", { name: "IWT" })).toBeInTheDocument();
    expect(screen.getByText("4FKC2")).toBeInTheDocument();
    expect(screen.queryByText(/Duplicate sensors/)).not.toBeInTheDocument();
  });

  it("shows what each copy carries — the facts that make it answerable", async () => {
    worklist();
    renderPage();

    expect(await screen.findByText("252 days")).toBeInTheDocument();
    expect(screen.getByText("100 days")).toBeInTheDocument();
    expect(screen.getByText("331k readings")).toBeInTheDocument();
    expect(screen.getByText("146k readings")).toBeInTheDocument();
  });

  it("counts only the questions a person has to answer", async () => {
    worklist();
    renderPage();

    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
  });

  it("recommends nothing — it marks what is true of each copy", async () => {
    worklist({ groups: [twoDead] });
    renderPage();

    expect(await screen.findByText("longest")).toBeInTheDocument();
    expect(screen.getByText(/stopped last/)).toBeInTheDocument();
    for (const word of [/recommended/i, /we suggest/i, /\bbest\b/i]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
  });

  it("keeps the copy the operator names, and only that one", async () => {
    worklist({ groups: [twoDead] });
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue(settledOk);
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: "Keep A" }));

    await waitFor(() =>
      expect(collapse).toHaveBeenCalledWith({
        groups: [{ device_tag: "4FKC2", point_tag: "IWT", survivor_point_id: "m-new" }],
      }),
    );
  });

  it("says why it is asking, in each of the two cases", async () => {
    worklist({ groups: [twoDead] });
    const { unmount } = renderWithProviders(<GhostPoints />);
    expect(
      await screen.findByText(/Neither copy has reported in the last 15 minutes/),
    ).toBeInTheDocument();
    unmount();

    worklist({
      groups: [
        {
          ...twoDead,
          members: [member({ point_id: "a", fresh: true }), member({ point_id: "b", fresh: true })],
        },
      ],
    });
    renderPage();
    expect(await screen.findByText(/More than one copy is reporting right now/)).toBeInTheDocument();
  });

  it("says what happens to the copy that is not kept — once", async () => {
    worklist({ groups: [twoDead] });
    renderPage();

    expect(await screen.findAllByText(/archived with their readings, and you can undo it/)).toHaveLength(1);
  });

  it("names a metric that reads a copy, so moving it is deliberate", async () => {
    worklist({
      groups: [
        {
          ...twoDead,
          members: [
            twoDead.members[0],
            { ...twoDead.members[1], has_role: true, role: "inlet_water_temp" },
          ],
        },
      ],
    });
    renderPage();

    expect(await screen.findByText(/A metric reads this copy \(inlet_water_temp\)/)).toBeInTheDocument();
  });
});

// ── skipping ─────────────────────────────────────────────────────────────────

describe("skipping", () => {
  const second = {
    ...twoDead,
    point_tag: "OWT",
    members: twoDead.members.map((m) => ({ ...m, point_id: `${m.point_id}-2` })),
  };

  it("moves on to the next sensor", async () => {
    worklist({ groups: [twoDead, second] });
    const user = renderPage();

    expect(await screen.findByRole("heading", { name: "IWT" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Skip this one/ }));

    expect(await screen.findByRole("heading", { name: "OWT" })).toBeInTheDocument();
  });

  it("does not lose what was skipped — it asks again", async () => {
    worklist({ groups: [twoDead] });
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: /Skip this one/ }));
    expect(await screen.findByText("1 skipped")).toBeInTheDocument();
    expect(screen.getByText(/still counted twice/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go through them again" }));
    expect(await screen.findByRole("heading", { name: "IWT" })).toBeInTheDocument();
  });
});

// ── deleting ─────────────────────────────────────────────────────────────────

describe("deleting a copy", () => {
  it("is offered only to a caller who holds the gateway's key too", async () => {
    // It destroys readings in two systems, so it takes iot.manage as well.
    canRef.fn = (p) => p !== "iot.manage";
    worklist({ groups: [twoDead] });
    renderPage();

    await screen.findByRole("heading", { name: "IWT" });
    expect(screen.queryByRole("button", { name: /not a real sensor/ })).not.toBeInTheDocument();
  });

  it("says what it destroys before anything is destroyed", async () => {
    worklist({ groups: [twoDead] });
    const remove = vi
      .spyOn(iot.points, "remove")
      .mockResolvedValue({ deleted: true, readings_deleted: 146220 } as never);
    const user = renderPage();

    await user.click((await screen.findAllByRole("button", { name: /not a real sensor/ }))[0]);

    expect(await screen.findByText(/It cannot be undone/)).toBeInTheDocument();
    expect(screen.getByText(/keep it and archive it instead/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Delete it and its readings/ }));
    // Copy A is the one whose button was pressed, never the other.
    await waitFor(() => expect(remove).toHaveBeenCalledWith("m-new"));
  });
});

// ── an archived copy that came back ──────────────────────────────────────────

describe("an archived copy reporting again", () => {
  const resurrected = [
    {
      point_id: "r1",
      device_tag: "1F-DB",
      point_tag: "KWH",
      category: "energy",
      last_seen_at: "2026-09-19T10:00:00Z",
      superseded_by: "p-new",
    },
  ];

  it("is surfaced as the fault it is, not folded back into the queue", async () => {
    worklist({ resurrected });
    renderPage();

    expect(await screen.findByText(/1 archived copy is reporting again/)).toBeInTheDocument();
  });

  it("ships the action that settles it", async () => {
    worklist({ resurrected });
    const restore = vi
      .spyOn(bi, "restoreGhosts")
      .mockResolvedValue({ restored: 1, requested: 1, points: [], refused: [] });
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: "Put this copy back" }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith({ point_ids: ["r1"] }));
    expect(await screen.findByText(/Metric links stay on the kept copy/)).toBeInTheDocument();
  });
});

// ── failure and permission ───────────────────────────────────────────────────

describe("a failed load", () => {
  it("reports the failure instead of an estate with no duplicates", async () => {
    vi.spyOn(bi, "ghosts").mockRejectedValue(new Error("reading store is unreachable"));
    renderPage();

    expect(await screen.findByText(/reading store is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing left to decide/)).not.toBeInTheDocument();
  });
});

describe("an operator without bi.manage", () => {
  it("reads the questions and is offered no write at all", async () => {
    canRef.fn = () => false;
    worklist({
      resurrected: [
        {
          point_id: "r1",
          device_tag: "1F-DB",
          point_tag: "KWH",
          category: "energy",
          last_seen_at: "2026-09-19T10:00:00Z",
          superseded_by: "p-new",
        },
      ],
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "IWT" })).toBeInTheDocument();
    expect(screen.getByText(/Answering needs/)).toHaveTextContent("bi.manage");
    for (const name of [/Keep /, /Settle/, /Put this copy back/, /not a real sensor/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
