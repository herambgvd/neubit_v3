/**
 * STRANDED ROLES is the screen whose single rule is "a score may order the
 * options and may never choose one". Every property below is that rule made
 * checkable:
 *
 *   • the EVIDENCE is what renders — the sentence the server wrote for every
 *     signal, not a number an operator would have to take on trust;
 *   • a successor that already carries a role is named as a refusal BEFORE the
 *     post, and cannot be moved onto silently;
 *   • an orphan with no successor says how many points were looked at, so "no
 *     successor found" is distinguishable from "the search did not run";
 *   • a batch reports every move's own outcome, because one transaction per move
 *     means a batch can half-apply;
 *   • an assertion whose point row is GONE renders as itself — no device, no
 *     successor offered — rather than as a blank superseded row;
 *   • forgetting that assertion — the one DESTRUCTIVE control here — names what
 *     it deletes, and who asserted it when, BEFORE it is pressed, takes one id,
 *     and cannot be reached in a single click;
 *   • a viewer without `bi.manage` is offered no write control at all.
 */
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import RoleSuccession from "./RoleSuccession";
import { bi } from "./api";

const can = vi.fn(() => true);
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: (p: string) => canRef.fn(p) }) }));
const canRef = { fn: can as (p: string) => boolean };

/** The real shape, from `1F York Chiller01`: the tag the role is bound to died
 *  on 5 September and the measurement is arriving under a new spelling. */
const chillerOrphan = {
  role: "inlet_water_temp",
  role_source: "operator",
  confirmed_by: "h.mishra",
  confirmed_at: "2026-09-01T06:00:00Z",
  point_id: "iwt-dead",
  device_tag: "1F York Chiller01",
  point_tag: "IWT",
  unit: "degC",
  category: "hvac",
  last_seen_at: "2026-09-05T04:00:00Z",
  fresh: false,
  device_last_seen_at: "2026-09-19T05:00:00Z",
  orphan_reason: "superseded",
  candidates_considered: 11,
  candidates: [
    {
      point_id: "iwt-live",
      point_tag: "1FYC1_IWT",
      unit: null,
      last_seen_at: "2026-09-19T05:00:00Z",
      fresh: false,
      score: 110,
      conflicting_role: null,
      evidence: [
        {
          kind: "measurement_tail",
          weight: 60,
          detail:
            "both tags end in `iwt` — this estate prefixes device identity onto the measurement and leaves the measurement last, so the tail is what survives a rename",
        },
        {
          kind: "role_convention",
          weight: 50,
          detail:
            "the tag's last token reads as `inlet_water_temp` by this estate's own role convention: the tag is `IWT`",
        },
      ],
    },
  ],
};

/** The YC2 spelling proposed for a role on a YC1 device, and it already carries
 *  a role of its own. Two different reasons to stop and read. */
const conflictedOrphan = {
  ...chillerOrphan,
  role: "outlet_water_temp",
  point_id: "owt-dead",
  device_tag: "2F York Chiller01",
  point_tag: "OWT",
  candidates_considered: 9,
  candidates: [
    {
      point_id: "owt-live",
      point_tag: "2FYC2_OWT",
      unit: "degC",
      last_seen_at: "2026-09-19T05:00:00Z",
      fresh: false,
      score: 60,
      conflicting_role: "inlet_water_temp",
      evidence: [
        {
          kind: "measurement_tail",
          weight: 60,
          detail: "both tags end in `owt` — the tail is what survives a rename",
        },
      ],
    },
  ],
};

/** Nothing credible on a device that was searched. */
const noSuccessorOrphan = {
  ...chillerOrphan,
  role: "chiller_power",
  point_id: "kw-dead",
  point_tag: "KW",
  candidates_considered: 11,
  candidates: [],
};

/** The in-flight case: the point row is not retired, it is GONE. No device, no
 *  tag, no candidates, and an `orphan_reason` this screen has never seen. */
const vanishedOrphan = {
  role: "flow_rate",
  role_source: "operator",
  confirmed_by: "h.mishra",
  confirmed_at: "2026-08-20T06:00:00Z",
  point_id: "flow-gone",
  device_tag: null,
  point_tag: null,
  unit: null,
  category: null,
  last_seen_at: null,
  fresh: false,
  device_last_seen_at: null,
  orphan_reason: "point_absent",
  candidates_considered: 0,
  candidates: [],
};

/** The shipped reason for the same case: `point_missing`, a role whose `points`
 *  row is gone. This is the one row on the estate the forget control exists for.
 *  `vanishedOrphan` above deliberately keeps an unrecognised reason, so the
 *  shape-detection path stays covered too. */
const missingOrphan = {
  ...vanishedOrphan,
  role: "condenser_flow",
  point_id: "cond-gone",
  role_source: "operator",
  confirmed_by: "h.mishra",
  confirmed_at: "2026-08-20T06:00:00Z",
  orphan_reason: "point_missing",
};

/** A second assertion in the same state, so "the id that was open" is
 *  distinguishable from "every missing one" — with a worklist of one, a sweep
 *  and a single id post the same body. */
const secondMissingOrphan = {
  ...missingOrphan,
  role: "condenser_return",
  point_id: "condr-gone",
};

/** A second movable role, so a batch can carry more than one move. */
const secondMovable = {
  ...chillerOrphan,
  role: "outlet_water_temp",
  point_id: "owt2-dead",
  point_tag: "OWT",
  candidates: [
    {
      ...chillerOrphan.candidates[0],
      point_id: "owt2-live",
      point_tag: "1FYC1_OWT",
      score: 110,
      evidence: [
        { kind: "measurement_tail", weight: 60, detail: "both tags end in `owt`" },
        { kind: "role_convention", weight: 50, detail: "the tag reads as `outlet_water_temp`" },
      ],
    },
  ],
};

function worklist(orphans: any[] = [chillerOrphan]) {
  return vi.spyOn(bi, "roleOrphans").mockResolvedValue({
    orphans,
    total: orphans.length,
    with_candidates: orphans.filter((o) => o.candidates.length).length,
    without_candidates: orphans.filter((o) => !o.candidates.length).length,
    fresh_minutes: 15,
    grace_minutes: 15,
  });
}

const renderPage = () => {
  renderWithProviders(<RoleSuccession />);
  return userEvent.setup();
};

beforeEach(() => {
  canRef.fn = () => true;
});

describe("what a candidate shows", () => {
  it("prints the evidence sentence for every signal, not only the score", async () => {
    worklist();
    const user = renderPage();

    await user.click(await screen.findByText("inlet_water_temp"));

    // The score is an ordering; these two sentences are what an operator checks.
    expect(
      await screen.findByText(/this estate prefixes device identity onto the measurement/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/reads as `inlet_water_temp` by this estate's own role convention/),
    ).toBeInTheDocument();
  });

  it("proposes nothing — the top candidate is never pre-chosen", async () => {
    worklist();
    const user = renderPage();

    await user.click(await screen.findByText("inlet_water_temp"));

    await screen.findByText("1FYC1_IWT");
    // No choice exists until a person makes one, so there is nothing to apply.
    expect(screen.queryByRole("button", { name: /Move the/ })).not.toBeInTheDocument();
  });

  it("says a lone candidate is the only OPTION, not the right answer", async () => {
    worklist([conflictedOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("outlet_water_temp"));

    expect(
      await screen.findByText(/only credible candidate on the device, which makes it the only/),
    ).toBeInTheDocument();
  });
});

describe("a successor that already carries a role", () => {
  it("names the refusal before the operator posts, and will not post it", async () => {
    worklist([conflictedOrphan]);
    const repoint = vi.spyOn(bi, "repointRoles").mockResolvedValue({});
    const user = renderPage();

    await user.click(await screen.findByText("outlet_water_temp"));
    await user.click(await screen.findByText("2FYC2_OWT"));

    expect(
      await screen.findByText(/A move onto it will be refused and nothing will be written/),
    ).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /Move the 1 role\(s\) you have chosen/ });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(repoint).not.toHaveBeenCalled();
  });
});

describe("an orphan with no successor", () => {
  it("says how many points were looked at, so it is not read as a screen that did not run", async () => {
    worklist([noSuccessorOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("chiller_power"));

    expect(
      await screen.findByText(/11 point\(s\) at this device's leading edge were looked at/),
    ).toBeInTheDocument();
  });

  it("distinguishes a search with nothing to look at from one that found nothing", async () => {
    worklist([{ ...noSuccessorOrphan, candidates_considered: 0 }]);
    const user = renderPage();

    await user.click(await screen.findByText("chiller_power"));

    expect(
      await screen.findByText(/No point on this device is at its leading edge/),
    ).toBeInTheDocument();
  });
});

describe("applying a batch", () => {
  it("posts exactly the moves the operator chose", async () => {
    worklist([chillerOrphan]);
    const repoint = vi
      .spyOn(bi, "repointRoles")
      .mockResolvedValue({ requested: 1, moved: 1, refused: 0, results: [] });
    const user = renderPage();

    await user.click(await screen.findByText("inlet_water_temp"));
    await user.click(await screen.findByText("1FYC1_IWT"));
    await user.click(screen.getByRole("button", { name: /Move the 1 role\(s\) you have chosen/ }));

    await waitFor(() =>
      expect(repoint).toHaveBeenCalledWith({
        moves: [
          { role: "inlet_water_temp", from_point_id: "iwt-dead", to_point_id: "iwt-live" },
        ],
      }),
    );
  });

  it("reports every move's own outcome when only some of them landed", async () => {
    worklist([chillerOrphan, secondMovable]);
    vi.spyOn(bi, "repointRoles").mockResolvedValue({
      requested: 2,
      moved: 1,
      refused: 1,
      results: [
        {
          role: "inlet_water_temp",
          from_point_id: "iwt-dead",
          to_point_id: "iwt-live",
          status: "moved",
          device_tag: "1F York Chiller01",
          from_point_tag: "IWT",
          to_point_tag: "1FYC1_IWT",
        },
        {
          role: "outlet_water_temp",
          from_point_id: "owt2-dead",
          to_point_id: "owt2-live",
          status: "refused",
          reason: "the point no longer carries `outlet_water_temp` — it carries no role",
        },
      ],
    });
    const user = renderPage();

    await user.click(await screen.findByText("inlet_water_temp"));
    await user.click(await screen.findByText("1FYC1_IWT"));
    await user.click(await screen.findByText("outlet_water_temp"));
    await user.click(await screen.findByText("1FYC1_OWT"));
    await user.click(screen.getByRole("button", { name: /Move the 2 role\(s\) you have chosen/ }));

    // The half that landed AND the half that did not — a summary count would
    // hide the refusal behind the success.
    expect(await screen.findByText(/2 move\(s\) requested · 1 moved · 1 refused/)).toBeInTheDocument();
    expect(screen.getByText(/moved on 1F York Chiller01 from/)).toBeInTheDocument();
    expect(
      screen.getByText(/refused — the point no longer carries `outlet_water_temp`/),
    ).toBeInTheDocument();
  });
});

describe("an assertion whose point is gone", () => {
  it("renders as itself — no device, and no successor invented for it", async () => {
    worklist([vanishedOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("flow_rate"));

    expect(
      await screen.findByText(/not in the reading store at all — not retired, absent/),
    ).toBeInTheDocument();
    expect(screen.getByText(/No successor can be offered/)).toBeInTheDocument();
    // And the worklist row says the same thing rather than printing an empty tag.
    expect(screen.getByText("no point row left")).toBeInTheDocument();
  });
});

describe("forgetting an assertion whose point is gone", () => {
  it("names the role, who asserted it and when, before anything is pressed", async () => {
    worklist([missingOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));

    // No press yet, and the screen has already said what would be destroyed.
    const warning = await screen.findByText(/This deletes/);
    const said = (warning.textContent || "").replace(/\s+/g, " ");
    expect(said).toContain("condenser_flow");
    expect(said).toContain("h.mishra");
    expect(said).toContain("stated as operator");
    expect(said).toContain("cond-gone");
    expect(said).toMatch(/Nothing puts it back/);
  });

  it("no longer claims the decision has no control on this screen", async () => {
    worklist([missingOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));

    expect(await screen.findByText(/that is the control below/)).toBeInTheDocument();
    expect(screen.queryByText(/has no control on this screen/)).not.toBeInTheDocument();
  });

  it("takes two presses and posts exactly the one id that was open", async () => {
    // Two rows in the same state: a control that swept would post both.
    worklist([missingOrphan, secondMissingOrphan]);
    const forget = vi
      .spyOn(bi, "forgetRoles")
      .mockResolvedValue({ requested: 1, forgotten: 1, refused: 0, results: [] });
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));
    await user.click(await screen.findByRole("button", { name: /Forget this assertion/ }));
    // The first press only opens the confirmation — nothing has been asked for.
    expect(forget).not.toHaveBeenCalled();

    await user.click(
      await screen.findByRole("button", { name: /Yes — forget condenser_flow permanently/ }),
    );

    // One id, from the row that is open. There is no shape here that could
    // express "every orphan whose point is missing".
    await waitFor(() => expect(forget).toHaveBeenCalledWith({ point_ids: ["cond-gone"] }));
  });

  it("can be called off without deleting anything", async () => {
    worklist([missingOrphan]);
    const forget = vi.spyOn(bi, "forgetRoles").mockResolvedValue({});
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));
    await user.click(await screen.findByRole("button", { name: /Forget this assertion/ }));
    await user.click(screen.getByRole("button", { name: /Keep the assertion/ }));

    expect(forget).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: /Forget this assertion/ }),
    ).toBeInTheDocument();
  });

  it("echoes the deleted assertion back — that response is the last copy of it", async () => {
    worklist([missingOrphan]);
    vi.spyOn(bi, "forgetRoles").mockResolvedValue({
      requested: 1,
      forgotten: 1,
      refused: 0,
      results: [
        {
          point_id: "cond-gone",
          status: "forgotten",
          role: "condenser_flow",
          role_source: "operator",
          confirmed_by: "h.mishra",
          confirmed_at: "2026-08-20T06:00:00Z",
        },
      ],
    });
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));
    await user.click(await screen.findByRole("button", { name: /Forget this assertion/ }));
    await user.click(
      screen.getByRole("button", { name: /Yes — forget condenser_flow permanently/ }),
    );

    expect(
      await screen.findByText(/1 assertion\(s\) named · 1 forgotten · 0 refused/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/forgotten — asserted by h\.mishra/),
    ).toBeInTheDocument();
  });

  it("renders a refusal's own reason rather than reporting a success", async () => {
    worklist([missingOrphan]);
    vi.spyOn(bi, "forgetRoles").mockResolvedValue({
      requested: 1,
      forgotten: 0,
      refused: 1,
      results: [
        {
          point_id: "cond-gone",
          status: "refused",
          role: "condenser_flow",
          reason:
            "the point still exists — `condenser_flow` is bound to a real row, so this is a repoint or an unbind, not a forget",
        },
      ],
    });
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));
    await user.click(await screen.findByRole("button", { name: /Forget this assertion/ }));
    await user.click(
      screen.getByRole("button", { name: /Yes — forget condenser_flow permanently/ }),
    );

    // A 200 carrying a refusal must not read as a deletion.
    expect(
      await screen.findByText(/refused — the point still exists/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/1 assertion\(s\) named · 0 forgotten · 1 refused/)).toBeInTheDocument();
  });

  it("is offered to nobody without bi.manage, and says which authority it needs", async () => {
    canRef.fn = () => false;
    worklist([missingOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("condenser_flow"));

    expect(screen.queryByRole("button", { name: /Forget this assertion/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/Forgetting an assertion needs/)).toBeInTheDocument();
    // …and the reader still sees why the row is here at all.
    expect(
      screen.getByText(/not in the reading store at all — not retired, absent/),
    ).toBeInTheDocument();
  });
});

describe("a failed load", () => {
  it("reports the failure instead of an estate with nothing stranded", async () => {
    vi.spyOn(bi, "roleOrphans").mockRejectedValue(new Error("reading store is unreachable"));

    renderPage();

    expect(await screen.findByText(/reading store is unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText(/No stranded role\./i)).not.toBeInTheDocument();
  });
});

describe("an operator without bi.manage", () => {
  it("reads the evidence and is offered no write control", async () => {
    canRef.fn = () => false;
    worklist([chillerOrphan]);
    const user = renderPage();

    await user.click(await screen.findByText("inlet_water_temp"));

    expect(screen.getByText(/Moving a role needs/i)).toBeInTheDocument();
    // The evidence is still readable — this is a screen for understanding the
    // estate as much as for changing it.
    expect(
      await screen.findByText(/this estate prefixes device identity onto the measurement/),
    ).toBeInTheDocument();
    // But picking a successor does nothing, so no move can ever be assembled.
    await user.click(screen.getByText("1FYC1_IWT"));
    expect(screen.queryByRole("button", { name: /Move the/ })).not.toBeInTheDocument();
  });
});

describe("undoing a move", () => {
  const MOVED = {
    requested: 1,
    moved: 1,
    refused: 0,
    results: [
      {
        role: "inlet_water_temp",
        from_point_id: "iwt-dead",
        to_point_id: "iwt-live",
        status: "moved",
        device_tag: "1F York Chiller01",
        from_point_tag: "IWT",
        to_point_tag: "1FYC1_IWT",
      },
    ],
  };

  async function applyOne() {
    worklist([chillerOrphan]);
    vi.spyOn(bi, "repointRoles").mockResolvedValue(MOVED);
    const user = renderPage();
    await user.click(await screen.findByText("inlet_water_temp"));
    await user.click(await screen.findByText("1FYC1_IWT"));
    await user.click(screen.getByRole("button", { name: /Move the 1 role\(s\) you have chosen/ }));
    await screen.findByText(/moved on 1F York Chiller01 from/);
    return user;
  }

  it("posts the move exactly as it was reported", async () => {
    // A repoint is a person deciding one tag is the same measurement another
    // used to be — and the tag can belong to the chiller next door.
    const undo = vi.spyOn(bi, "undoRepoints").mockResolvedValue({
      requested: 1, undone: 1, refused: 0,
      results: [{ role: "inlet_water_temp", from_point_id: "iwt-dead",
                  to_point_id: "iwt-live", status: "undone" }],
    });
    const user = await applyOne();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(undo).toHaveBeenCalledWith({
        moves: [
          { role: "inlet_water_temp", from_point_id: "iwt-dead", to_point_id: "iwt-live" },
        ],
      }),
    );
  });

  it("stops calling it a move that happened once it has been put back", async () => {
    vi.spyOn(bi, "undoRepoints").mockResolvedValue({
      requested: 1, undone: 1, refused: 0,
      results: [{ role: "inlet_water_temp", from_point_id: "iwt-dead",
                  to_point_id: "iwt-live", status: "undone" }],
    });
    const user = await applyOne();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() =>
      expect(screen.queryByText(/moved on 1F York Chiller01 from/)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/1 move\(s\) requested · 0 moved/)).toBeInTheDocument();
  });

  it("says WHY when the estate has moved past the move, and keeps it listed", async () => {
    // The server refuses anything that is not the succession on record. An undo
    // reported as done would leave the operator believing a role is somewhere
    // it is not.
    vi.spyOn(bi, "undoRepoints").mockResolvedValue({
      requested: 1, undone: 0, refused: 1,
      results: [{ role: "inlet_water_temp", from_point_id: "iwt-dead",
                  to_point_id: "iwt-live", status: "refused",
                  reason: "this move is not the one on record" }],
    });
    const user = await applyOne();
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByText(/not undone — this move is not the one on record/))
      .toBeInTheDocument();
    // The move still stands, so the row still reads as one and the count is
    // unchanged. Restating it as a refusal would say the role is somewhere it
    // is not.
    expect(screen.getByText(/moved on 1F York Chiller01 from/)).toBeInTheDocument();
    expect(screen.getByText(/1 move\(s\) requested · 1 moved/)).toBeInTheDocument();
  });

  it("is offered on a move, never on a refusal", async () => {
    worklist([chillerOrphan]);
    vi.spyOn(bi, "repointRoles").mockResolvedValue({
      requested: 1, moved: 0, refused: 1,
      results: [{ role: "inlet_water_temp", from_point_id: "iwt-dead",
                  to_point_id: "iwt-live", status: "refused", reason: "nope" }],
    });
    const user = renderPage();
    await user.click(await screen.findByText("inlet_water_temp"));
    await user.click(await screen.findByText("1FYC1_IWT"));
    await user.click(screen.getByRole("button", { name: /Move the 1 role\(s\) you have chosen/ }));

    expect(await screen.findByText(/refused — nope/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });
});
