/**
 * DUPLICATE POINTS is the screen whose single rule is "a bulk answer may only
 * reach a question the data already settled". Every property below is that rule
 * made checkable:
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

const can = vi.fn(() => true);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));
const canRef = { fn: can as (p: string) => boolean };

interface Member {
  point_id: string;
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

beforeEach(() => {
  canRef.fn = () => true;
});

describe("the sweep", () => {
  it("counts only the groups that need no choice", async () => {
    worklist();

    renderPage();

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
    const user = renderPage();

    await user.click(await screen.findByRole("button", { name: /Collapse the 1 group/ }));

    await waitFor(() => expect(collapse).toHaveBeenCalledWith({ mode: "auto" }));
    // Never the manual pair, by id or by name.
    expect(JSON.stringify(collapse.mock.calls)).not.toContain("IWT");
  });

  it("has nothing to press when every pair needs a choice", async () => {
    worklist({ groups: [manualGroup] });

    renderPage();

    expect(await screen.findByText(/None here is in that state/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Collapse the/ })).not.toBeInTheDocument();
  });
});

describe("a pair that needs a choice", () => {
  it("proposes no survivor and refuses to collapse until one is named", async () => {
    worklist({ groups: [manualGroup] });
    const collapse = vi.spyOn(bi, "collapseGhosts").mockResolvedValue({});
    const user = renderPage();

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
    const user = renderPage();

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
    const user = renderPage();

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
    const user = renderPage();

    await user.click(await screen.findByText("IWT"));

    expect(await screen.findByText("dimensionless")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
  });

  it("names the role a collapse would move, rather than leaving the cell blank", async () => {
    worklist({ groups: [manualGroup] });
    const user = renderPage();

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
    const user = renderPage();

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
