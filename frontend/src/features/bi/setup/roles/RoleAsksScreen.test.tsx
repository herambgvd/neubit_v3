/**
 * What each reading means, device by device — and what each press SENDS.
 *
 *   • only devices with something to answer are the worklist, most urgent first;
 *   • a question shows the reading's live value and the tag's own reason, and
 *     says which numbers read it;
 *   • "Yes" stores that one meaning; "Yes to N on this device" presses once per
 *     role and never includes a cautioned question;
 *   • a stored answer can be TAKEN BACK (role: null);
 *   • a refusal because the reading carries nothing is CHALLENGED, and asserting
 *     anyway is a second, deliberate press that sends the acknowledgement;
 *   • a viewer without bi.manage sees the questions and no control that writes.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import RoleAsksScreen from "./RoleAsksScreen";

const perms = { granted: new Set(["bi.read", "bi.manage"]), modules: new Set(["analytics"]) };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

const T = "2026-09-20T10:00:00Z";
const q = (over: object = {}) => ({
  point_id: "p1", point_tag: "IWT", answered: false, role: "inlet_water_temp",
  role_label: "Entering water temperature", basis: "the tag is `IWT` — entering water temperature by this estate's convention",
  needed_by: ["chiller_delta_t"], value: 28.4, at: T, unit: "degC", reporting: true,
  same_role_answered: [], same_role_others: [], ...over,
});

// The live estate: one chiller with two temperatures to answer and its register
// already answered, and one board with a register waiting.
const ASKS = {
  lookback_hours: 48,
  roles_read: [
    { role: "energy_register", label: "Energy register", needed_by: ["carbon_intensity"] },
    { role: "inlet_water_temp", label: "Entering water temperature", needed_by: ["chiller_delta_t"] },
  ],
  devices: [
    {
      device_id: "d1", device_tag: "4F Khem Chiller02", site_id: "s1", site_name: "Aeon Tower",
      asks: [
        q({ point_id: "p1", point_tag: "IWT" }),
        q({ point_id: "p2", point_tag: "OWT", role: "outlet_water_temp", role_label: "Leaving water temperature", value: 25.8 }),
      ],
      stranded: [
        {
          point_id: "o1", point_tag: "IWT", role: "inlet_water_temp",
          role_label: "Entering water temperature", reason: "superseded", last_seen_at: null,
          confirmed_by: "ops@geniusvision.in", candidates_considered: 9,
          successors: [
            {
              point_id: "p7", point_tag: "4FKC2_IWT", score: 4,
              evidence: [{ kind: "measurement_tail", weight: 3, detail: "the same readings at the tail" }],
            },
          ],
          needed_by: ["chiller_delta_t"],
        },
      ],
      answered: [
        q({ point_id: "p9", point_tag: "4FKC2_kWh", answered: true, role: "energy_register",
            role_label: "Energy register", needed_by: ["carbon_intensity"], value: 5538.8, unit: "kWh",
            confirmed_by: "ops@geniusvision.in", confirmed_at: T }),
      ],
    },
    {
      device_id: "d2", device_tag: "4F-3F AC DB", site_id: "s1", site_name: "Aeon Tower",
      asks: [q({ point_id: "p3", point_tag: "KWH", role: "energy_register", role_label: "Energy register",
                 needed_by: ["carbon_intensity"], value: 25009, unit: "kWh",
                 basis: "the tag names a kWh register" })],
      answered: [],
      stranded: [],
    },
  ],
  unreachable: [
    {
      point_id: "u1", point_tag: null, role: "outlet_water_temp",
      role_label: "Leaving water temperature", reason: "point_missing", last_seen_at: null,
      confirmed_by: "ops@geniusvision.in", candidates_considered: 0, successors: [],
      needed_by: ["chiller_delta_t"],
    },
  ],
  totals: { points: 494, devices: 2, asks: 3, answered: 1, stranded: 2 },
};

let stub: ApiStub;

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /bi/points/roles/asks": ASKS,
    "POST /bi/metrics/roles/confirm": { updated: 1 },
    "POST /bi/points/roles/repoint": { results: [{ status: "moved" }] },
    "POST /bi/points/roles/repoint/undo": { results: [{ status: "undone" }] },
    "POST /bi/points/roles/forget": { results: [{ status: "forgotten" }] },
  });
});

const render = () => {
  renderWithProviders(<RoleAsksScreen />);
  return userEvent.setup();
};
const confirms = () => stub.matching("POST /bi/metrics/roles/confirm").map((c) => c.body);

describe("the worklist", () => {
  it("lists only the devices with something to answer, and says how little is waiting", async () => {
    render();

    expect(await screen.findByRole("heading", { name: "4F Khem Chiller02" })).toBeInTheDocument();
    expect(screen.getByText(/3 readings on 2 devices — everything else is left alone/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /4F-3F AC DB/ })).toHaveTextContent("1 reading to answer");
    // 494 readings exist; the screen is not a list of them.
    expect(screen.queryByText(/494/)).not.toBeInTheDocument();
  });

  it("counts the answers stranded on a dead reading, and they are settled here", async () => {
    render();
    expect(await screen.findByRole("button", { name: /2 answers point at a dead reading/ })).toBeInTheDocument();
    expect(screen.getByText(/Answered on a reading that stopped coming/)).toBeInTheDocument();
  });

  it("moves to another device when it is picked", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /4F-3F AC DB/ }));
    expect(await screen.findByRole("heading", { name: "4F-3F AC DB" })).toBeInTheDocument();
    expect(screen.getByText(/the tag names a kWh register/i)).toBeInTheDocument();
  });
});

describe("a question", () => {
  it("shows the reading, what it looks like, and which number reads it", async () => {
    render();
    // `IWT` is a question here AND a stranded answer, and the device has two
    // questions, so the card is found through this question's own value.
    const card = (await screen.findByText("28.4 degC")).closest("div")!.parentElement!;
    expect(card).toHaveTextContent("28.4 degC");
    expect(card).toHaveTextContent("the water going in");
    expect(card).toHaveTextContent("how hard this chiller is working");
  });

  it("stores that one meaning on Yes", async () => {
    const user = render();
    await user.click((await screen.findAllByRole("button", { name: "Yes" }))[0]);

    await waitFor(() => expect(confirms()).toEqual([{ point_ids: ["p1"], role: "inlet_water_temp" }]));
  });

  it("stores nothing when the operator says it is something else", async () => {
    const user = render();
    await user.click((await screen.findAllByRole("button", { name: "It is something else" }))[0]);

    expect(screen.getByText(/stays off and says why/)).toBeInTheDocument();
    expect(confirms()).toEqual([]);
  });
});

describe("the whole device at once", () => {
  it("presses once per role", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Yes to 2 on this device" }));

    await waitFor(() => expect(confirms()).toHaveLength(2));
    expect(confirms()).toEqual([
      { point_ids: ["p1"], role: "inlet_water_temp" },
      { point_ids: ["p2"], role: "outlet_water_temp" },
    ]);
  });

  it("leaves out a reading the platform is unsure about", async () => {
    stub.set({
      "GET /bi/points/roles/asks": {
        ...ASKS,
        devices: [
          {
            ...ASKS.devices[0],
            asks: [q({ point_id: "p1" }), q({ point_id: "p2", point_tag: "OWT", role: "outlet_water_temp", reporting: false })],
          },
          ASKS.devices[1],
        ],
      },
    });
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Yes to 1 on this device" }));

    await waitFor(() => expect(confirms()).toEqual([{ point_ids: ["p1"], role: "inlet_water_temp" }]));
    expect(screen.getByText(/nothing has arrived from this reading recently/)).toBeInTheDocument();
  });
});

describe("an answer already stored", () => {
  it("can be taken back", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Take it back" }));

    await waitFor(() => expect(confirms()).toEqual([{ point_ids: ["p9"], role: null }]));
  });
});

describe("a reading carrying nothing", () => {
  it("is challenged, and asserting anyway is a second press that says so", async () => {
    // The `4FKC2_IWT` mistake: a role bound to a point that publishes nothing,
    // accepted, then refusing no_data for days.
    let first = true;
    stub.set({
      "POST /bi/metrics/roles/confirm": () => {
        if (first) {
          first = false;
          return httpError(422, "Not stored: 1 of the selected point(s) are carrying no readings.", "POINT_NOT_REPORTING");
        }
        return { updated: 1 };
      },
    });
    const user = render();
    await user.click((await screen.findAllByRole("button", { name: "Yes" }))[0]);

    const banner = await screen.findByText(/carrying no readings/);
    expect(banner).toBeInTheDocument();
    expect(confirms()).toEqual([{ point_ids: ["p1"], role: "inlet_water_temp" }]);

    await user.click(screen.getByRole("button", { name: /anyway/i }));
    await waitFor(() =>
      expect(confirms()[1]).toEqual({
        point_ids: ["p1"],
        role: "inlet_water_temp",
        acknowledge_not_reporting: true,
      }),
    );
  });
});

describe("an answer left on a reading that stopped coming", () => {
  it("says why, offers the successor with the evidence, and moves only on a press", async () => {
    const user = render();
    await screen.findByText(/Answered on a reading that stopped coming/);
    expect(screen.getByText(/renamed away/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "why this one" }));
    expect(screen.getByText("the same readings at the tail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Move the answer here" }));
    await waitFor(() =>
      expect(stub.body("POST /bi/points/roles/repoint")).toEqual({
        moves: [{ role: "inlet_water_temp", from_point_id: "o1", to_point_id: "p7" }],
      }),
    );
    // Offered where the mistake is noticed.
    expect(await screen.findByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("offers only forgetting when the reading no longer exists at all", async () => {
    const user = render();
    // No device left to read means no candidate set: a move cannot be offered.
    const card = (await screen.findByText(/there is no device left to move them onto/)).closest("div")!;
    expect(within(card).queryByRole("button", { name: "Move the answer here" })).not.toBeInTheDocument();

    await user.click(within(card).getAllByRole("button", { name: "Forget this answer" })[0]);
    await user.click(within(card).getByRole("button", { name: "Forget it" }));
    await waitFor(() => expect(stub.body("POST /bi/points/roles/forget")).toEqual({ point_ids: ["u1"] }));
  });

  it("is forgotten only after a second press that names what it destroys", async () => {
    const user = render();
    // The one on the device, not the one with no device left.
    const onDevice = (await screen.findByText(/renamed away/)).closest("div")!;
    await user.click(within(onDevice).getByRole("button", { name: "Forget this answer" }));

    expect(within(onDevice).getByText(/It is deleted, and nothing puts it back/)).toBeInTheDocument();
    expect(stub.matching("POST /bi/points/roles/forget")).toHaveLength(0);

    await user.click(within(onDevice).getByRole("button", { name: "Forget it" }));
    await waitFor(() => expect(stub.body("POST /bi/points/roles/forget")).toEqual({ point_ids: ["o1"] }));
  });
});

describe("the gate", () => {
  it("reads nothing without bi.read and the analytics module", async () => {
    perms.granted = new Set(["sites.read"]);
    render();
    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("shows a viewer without bi.manage the questions and no control that writes", async () => {
    perms.granted = new Set(["bi.read"]);
    render();

    expect(await screen.findByText("28.4 degC")).toBeInTheDocument();
    for (const name of ["Yes", /^Yes to/, "Take it back", "Skip this device", "Forget this answer", "Move the answer here"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
