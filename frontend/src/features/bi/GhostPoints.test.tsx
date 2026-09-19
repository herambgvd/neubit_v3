/**
 * DUPLICATE SENSORS is the screen whose single rule is "a bulk answer may only
 * reach a question the data already settled". Every property below is that rule
 * made checkable.
 *
 * The screen OPENS on one question at a time; the worklist asserted here is the
 * other view, one press away, so these tests reach it through that press —
 * which is itself the check that the press is there.
 *
 * The properties:
 *
 *   • the sweep posts `mode: "auto"` and counts only the groups that need no
 *     choice — a group that needs one can never be swept by it;
 *   • a group that needs a choice proposes nothing: no survivor is pre-ticked
 *     and the collapse is refused until a person names one;
 *   • a resurrected point — superseded, and reporting again — is surfaced with
 *     the action that settles it, never folded back into the worklist;
 *   • a viewer without `bi.manage` is offered no write control at all.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import GhostPoints from "./GhostPoints";
import { bi } from "./api";
import { iot } from "@/features/iot/api";

const can = vi.fn(() => true);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));
const canRef = { fn: can as (p: string) => boolean };

interface Member {
  point_id: string;
  first_seen_at?: string | null;
  readings?: number | null;
  last_seen_at: string | null;
  unit: string | null;
  fresh: boolean;
  has_role: boolean;
  role: string | null;
}

const member = (over: Partial<Member> & { point_id: string }): Member => ({
  last_seen_at: "2026-09-19T09:00:00Z",
  unit: null,
  fresh: false,
  has_role: false,
  role: null,
  ...over,
});

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

const manualGroup = {
  device_tag: "4FKC2",
  point_tag: "IWT",
  category: "hvac",
  mode: "manual",
  survivor_point_id: null,
  members: [
    member({ point_id: "m-a", last_seen_at: "2026-07-01T09:00:00Z" }),
    member({ point_id: "m-b", last_seen_at: "2026-08-01T09:00:00Z", has_role: true, role: "inlet_water_temp" }),
  ],
};

function worklist(over: Record<string, unknown> = {}) {
  const groups = (over.groups as any[]) ?? [autoGroup, manualGroup];
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

/** Open the worklist view. The screen opens on the one-question walk. */
async function renderList() {
  const user = renderPage();
  await user.click(await screen.findByRole("button", { name: "See the whole list instead" }));
  return user;
}

beforeEach(() => {
  canRef.fn = () => true;
});

describe("the sweep", () => {
  it("counts only the groups that need no choice", async () => {
    worklist();

    await renderList();

    // Two duplicated pairs, one sweepable. "Collapse the 2" would be the bug.
    expect(
      await screen.findByRole("button", { name: /Collapse the 1 group\(s\) that need no choice/ }),
    ).toBeInTheDocument();
  });

  it("asks the server for the automatic mode, never for a group that needs a choice", async () => {
    worklist();
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue({
      groups_collapsed: 1,
      points_retired: 1,
      roles_migrated: 0,
      roles_discarded: 0,
      groups_skipped: 0,
      skipped: [],
    });
    const user = await renderList();

    await user.click(await screen.findByRole("button", { name: /Collapse the 1 group/ }));

    await waitFor(() => expect(collapse).toHaveBeenCalledWith({ mode: "auto" }));
    // Never the manual pair, by id or by name.
    expect(JSON.stringify(collapse.mock.calls)).not.toContain("IWT");
  });

  it("has nothing to press when every pair needs a choice", async () => {
    worklist({ groups: [manualGroup] });

    await renderList();

    expect(await screen.findByText(/None here is in that state/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse the/ })).not.toBeInTheDocument();
  });
});

describe("a pair that needs a choice", () => {
  it("proposes no survivor and refuses to collapse until one is named", async () => {
    worklist({ groups: [manualGroup] });
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue({});
    const user = await renderList();

    await user.click(await screen.findByText("IWT"));

    expect(
      await screen.findByText(/No generation has reported in the last 15 minutes/),
    ).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Collapse into the point marked keep/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(collapse).not.toHaveBeenCalled();
  });

  it("collapses onto the generation the operator picked, once they have picked one", async () => {
    worklist({ groups: [manualGroup] });
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue({
      groups_collapsed: 1,
      points_retired: 1,
      roles_migrated: 1,
      roles_discarded: 0,
      groups_skipped: 0,
      skipped: [],
    });
    const user = await renderList();

    await user.click(await screen.findByText("IWT"));
    await user.click(await screen.findByText("m-b"));
    await user.click(screen.getByRole("button", { name: /Collapse into the point marked keep/ }));

    await waitFor(() =>
      expect(collapse).toHaveBeenCalledWith({
        groups: [{ device_tag: "4FKC2", point_tag: "IWT", survivor_point_id: "m-b" }],
      }),
    );
  });

  it("says WHICH manual case this is — two live generations is not the same fault", async () => {
    worklist({
      groups: [
        {
          ...manualGroup,
          members: [
            member({ point_id: "m-a", fresh: true }),
            member({ point_id: "m-b", fresh: true }),
          ],
        },
      ],
    });
    const user = await renderList();

    await user.click(await screen.findByText("IWT"));

    expect(await screen.findByText(/2 generations are reporting right now/)).toBeInTheDocument();
  });
});

describe("a resurrected point", () => {
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

  it("is surfaced as the disagreement it is, not folded back into the worklist", async () => {
    worklist({ resurrected });

    renderPage();

    expect(
      await screen.findByText(/1 superseded point\(s\) are reporting again/),
    ).toBeInTheDocument();
  });

  it("ships the action that settles it", async () => {
    worklist({ resurrected });
    const restore = vi
      .spyOn(bi, "restoreGhosts")
      .mockResolvedValue({ restored: 1, requested: 1, points: [], refused: [] });
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: /Put this point back/ }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith({ point_ids: ["r1"] }));
    expect(await screen.findByText(/Roles are not put back/)).toBeInTheDocument();
  });
});

describe("what a generation's row says", () => {
  it("distinguishes a confirmed dimensionless unit from one nobody recorded", async () => {
    worklist({
      groups: [
        {
          ...manualGroup,
          members: [member({ point_id: "m-a", unit: "" }), member({ point_id: "m-b", unit: null })],
        },
      ],
    });
    const user = await renderList();

    await user.click(await screen.findByText("IWT"));

    expect(await screen.findByText("dimensionless")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
  });

  it("names the role a collapse would move, rather than leaving the cell blank", async () => {
    worklist({ groups: [manualGroup] });
    const user = await renderList();

    await user.click(await screen.findByText("IWT"));

    expect(await screen.findByText("inlet_water_temp")).toBeInTheDocument();
    expect(screen.getByText("none bound")).toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it("reports the failure instead of an estate with no duplicates", async () => {
    vi.spyOn(bi, "ghosts").mockRejectedValue(new Error("reading store is unreachable"));

    renderPage();

    expect(await screen.findByText(/reading store is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No duplicated pair in this view/i)).not.toBeInTheDocument();
  });
});

describe("an operator without bi.manage", () => {
  it("reads the worklist and is offered no write control", async () => {
    canRef.fn = () => false;
    worklist({ resurrected: [
      {
        point_id: "r1",
        device_tag: "1F-DB",
        point_tag: "KWH",
        category: "energy",
        last_seen_at: "2026-09-19T10:00:00Z",
        superseded_by: "p-new",
      },
    ] });
    const user = await renderList();

    await screen.findByText("IWT");
    expect(screen.getByText(/Collapsing a duplicate needs/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse the/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Put this point back/ })).not.toBeInTheDocument();

    // And selecting a pair still offers nothing: no survivor can be ticked, so
    // no collapse button can appear.
    await user.click(screen.getByText("IWT"));
    expect(
      screen.queryByRole("button", { name: /Collapse into the point marked keep/ }),
    ).not.toBeInTheDocument();
  });
});


// ── one question at a time ───────────────────────────────────────────────────

describe("the walk", () => {
  /** Two records of one register, neither sending: the case 45 of the 46 pairs
   *  on the live estate are in, and the one the old screen could not answer. */
  const twoDead = {
    ...manualGroup,
    members: [
      member({
        point_id: "m-old",
        first_seen_at: "2026-01-02T11:05:00Z",
        last_seen_at: "2026-09-11T16:16:00Z",
        readings: 331_440,
      } as never),
      member({
        point_id: "m-new",
        first_seen_at: "2026-06-03T09:40:00Z",
        last_seen_at: "2026-09-11T17:12:00Z",
        readings: 146_220,
      } as never),
    ],
  };

  it("opens on ONE question, with what each record carries", async () => {
    worklist({ groups: [autoGroup, twoDead] });
    renderPage();

    expect(await screen.findByText("Which record is the real sensor?")).toBeInTheDocument();
    // The facts that make it answerable — neither is on the old screen.
    expect(screen.getByText("252 days")).toBeInTheDocument();
    expect(screen.getByText("100 days")).toBeInTheDocument();
    expect(screen.getByText("331k")).toBeInTheDocument();
    expect(screen.getByText("146k")).toBeInTheDocument();
  });

  it("counts only the questions a person has to answer", async () => {
    // The auto pair is the sweep's. Counting it here would ask an operator to
    // confirm what the data already settled.
    worklist({ groups: [autoGroup, twoDead] });
    renderPage();

    expect(await screen.findByText("question 1 of 1")).toBeInTheDocument();
  });

  it("recommends nothing — it states what is true of each record", async () => {
    worklist({ groups: [twoDead] });
    renderPage();

    expect(await screen.findByText("holds the most history")).toBeInTheDocument();
    expect(screen.getByText("stopped last")).toBeInTheDocument();
    for (const word of [/recommended/i, /we suggest/i, /best/i]) {
      expect(screen.queryByText(word)).not.toBeInTheDocument();
    }
  });

  it("keeps the record the operator names, and only that one", async () => {
    worklist({ groups: [twoDead] });
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue({
      groups_collapsed: 1, points_retired: 1, roles_migrated: 0, roles_discarded: 0,
      groups_skipped: 0, skipped: [],
    });
    const user = renderPage();

    await user.click((await screen.findAllByRole("button", { name: "This one is the sensor" }))[0]);

    await waitFor(() =>
      expect(collapse).toHaveBeenCalledWith({
        groups: [{ device_tag: "4FKC2", point_tag: "IWT", survivor_point_id: "m-new" }],
      }),
    );
  });

  it("says why it is asking, in the two different cases", async () => {
    worklist({ groups: [twoDead] });
    const { unmount } = renderWithProviders(<GhostPoints />);
    expect(await screen.findByText(/Neither record has sent anything in the last 15 minutes/)).toBeInTheDocument();
    unmount();

    worklist({
      groups: [{
        ...manualGroup,
        members: [member({ point_id: "a", fresh: true }), member({ point_id: "b", fresh: true })],
      }],
    });
    renderPage();
    expect(await screen.findByText(/More than one record is sending right now/)).toBeInTheDocument();
  });

  it("lets an operator skip one they cannot answer, and moves on", async () => {
    worklist({
      groups: [
        twoDead,
        { ...twoDead, point_tag: "OWT", members: twoDead.members.map((m) => ({ ...m, point_id: `${m.point_id}-2` })) },
      ],
    });
    const user = renderPage();

    expect(await screen.findByText("question 1 of 2")).toBeInTheDocument();
    expect(screen.getByText(/4FKC2 · IWT/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /skip this one/ }));

    expect(await screen.findByText(/4FKC2 · OWT/)).toBeInTheDocument();
  });

  it("offers a viewer without bi.manage no way to answer, and says which key", async () => {
    canRef.fn = (p: string) => p !== "bi.manage";
    worklist({ groups: [twoDead] });
    renderPage();

    expect(await screen.findByText("Which record is the real sensor?")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "This one is the sensor" })).not.toBeInTheDocument();
    expect(screen.getByText(/Answering needs/)).toHaveTextContent("bi.manage");
  });

  it("says plainly what happens to the record that is not kept", async () => {
    worklist({ groups: [twoDead] });
    renderPage();

    expect(await screen.findByText(/the others are filed away, pointing at it/)).toBeInTheDocument();
    expect(screen.getByText(/old readings stay exactly where they are/)).toBeInTheDocument();
  });
});

describe("deleting a record", () => {
  const twoDead = {
    ...manualGroup,
    members: [
      member({ point_id: "m-old", first_seen_at: "2026-01-02T11:05:00Z", readings: 331_440 } as never),
      member({ point_id: "m-new", first_seen_at: "2026-06-03T09:40:00Z", readings: 146_220 } as never),
    ],
  };

  it("is offered only to a caller who holds the gateway's key too", async () => {
    // It destroys readings in two systems, so it takes iot.manage as well.
    canRef.fn = (p: string) => p !== "iot.manage";
    worklist({ groups: [twoDead] });
    renderPage();

    await screen.findByText("Which record is the real sensor?");
    expect(screen.queryByRole("button", { name: /Not a real sensor/ })).not.toBeInTheDocument();
  });

  it("says what it destroys before it is pressed, and is not the same as keeping", async () => {
    worklist({ groups: [twoDead] });
    const remove = vi.spyOn(iot.points, "remove").mockResolvedValue({ deleted: true, readings_deleted: 331440 } as never);
    const user = renderPage();

    await user.click((await screen.findAllByRole("button", { name: /Not a real sensor/ }))[0]);

    expect(await screen.findByText(/It cannot be undone/)).toBeInTheDocument();
    expect(screen.getByText(/keep it and file it away instead/)).toBeInTheDocument();
    // Nothing is destroyed on opening the warning.
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Delete it and its readings/ }));
    // The record whose tile was pressed, never the other one.
    await waitFor(() => expect(remove).toHaveBeenCalledWith("m-old"));
  });
});
