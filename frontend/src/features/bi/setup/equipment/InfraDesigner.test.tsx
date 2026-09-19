/**
 * The infra designer is where a chiller gets the facts Building Intelligence
 * judges it by, so what it may SEND is the substance here:
 *
 *   • every picker is the server's vocabulary — a kind or class the UI does not
 *     know about still appears, and a class that cannot sit in this system
 *     does not;
 *   • a class offers only its own slots and facts;
 *   • a binding sends both tags, and a 409 is shown as the server wrote it;
 *   • the design PUT replaces the whole set, so editing one fact must send the
 *     others back unchanged, and clearing one must be asked for;
 *   • an import is a dry run first, and writes only on a second, explicit press;
 *   • it rides BI's gate, not Sites': `bi.read` + the `analytics` module to
 *     read, `bi.manage` to write. `sites.*` opens nothing here any more.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EquipmentPublic, InfraVocabulary, InfrastructureTree } from "@/lib/types";
import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import InfraDesigner from "./InfraDesigner";

const perms = { granted: new Set(["bi.read", "bi.manage"]), modules: new Set(["analytics"]) };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

// Deliberately NOT the backend's word list: a kind and a class no hard-coded
// UI list could contain, so a picker that shows them read the vocabulary.
const VOCAB: InfraVocabulary = {
  system_kinds: [
    { key: "chw_plant", label: "Chilled-water plant loop", description: "One chilled-water loop." },
    { key: "district_tiein", label: "District cooling tie-in", description: "A metered tie-in." },
    { key: "power", label: "Power chain", description: "Meters and DG sets." },
  ],
  equipment_classes: [
    {
      key: "chiller",
      label: "Chiller",
      system_kinds: ["chw_plant"],
      slots: ["chws", "chwr", "kw"],
      facts: ["make", "tr", "design_dt_min", "design_dt_max"],
    },
    {
      key: "absorption_chiller",
      label: "Absorption chiller",
      system_kinds: ["chw_plant"],
      slots: ["chws"],
      facts: ["make"],
    },
    {
      key: "chw_primary_pump",
      label: "Primary CHW pump",
      system_kinds: ["chw_plant"],
      slots: ["run_status", "kw"],
      facts: ["make", "kw_rated"],
    },
    { key: "dg_set", label: "Diesel generator", system_kinds: ["power"], slots: ["kw"], facts: ["kva_rated"] },
  ],
  slots: [
    { key: "chws", dimension: "temperature", label: "CHW supply (leaving) temperature", role: "outlet_water_temp" },
    { key: "chwr", dimension: "temperature", label: "CHW return (entering) temperature", role: "inlet_water_temp" },
    { key: "kw", dimension: "power", label: "Active power", role: "active_power" },
    { key: "run_status", dimension: "state", label: "Run status", role: null },
  ],
  design_facts: [
    { key: "make", type: "text", unit: null, label: "Make" },
    { key: "tr", type: "number", unit: "TR", label: "Rated capacity (refrigeration tons)" },
    { key: "kw_rated", type: "number", unit: "kW", label: "Rated power" },
    { key: "kva_rated", type: "number", unit: "kVA", label: "Rated apparent power" },
    { key: "design_dt_min", type: "number", unit: "K", label: "Design CHW ΔT, lower bound" },
    { key: "design_dt_max", type: "number", unit: "K", label: "Design CHW ΔT, upper bound" },
  ],
};

const T = "2026-09-01T00:00:00Z";

const equipment = (over: Partial<EquipmentPublic>): EquipmentPublic => ({
  equipment_id: "e1",
  site_id: "s1",
  system_id: "sys1",
  tag: "CH-01",
  name: null,
  equipment_class: "chiller",
  design: {},
  design_units: {},
  slots: [],
  created_at: T,
  updated_at: T,
  ...over,
});

const CHILLER = equipment({
  design: { make: "York", tr: 350, design_dt_min: 5, design_dt_max: 7 },
  design_units: { tr: "TR", design_dt_min: "K", design_dt_max: "K" },
  slots: [{ slot: "chwr", device_tag: "CH1", point_tag: "IWT", bound: true }],
});
const PUMP = equipment({ equipment_id: "e2", tag: "PP-01", equipment_class: "chw_primary_pump", design: { make: "Grundfos" } });

const tree = (eq: EquipmentPublic[] = [CHILLER, PUMP]): InfrastructureTree => ({
  site_id: "s1",
  systems: [
    {
      system_id: "sys1",
      site_id: "s1",
      name: "Plant A",
      kind: "chw_plant",
      description: null,
      created_at: T,
      updated_at: T,
      equipment: eq,
    },
  ],
});

let stub: ApiStub;

beforeEach(() => {
  perms.granted = new Set(["bi.read", "bi.manage"]);
  perms.modules = new Set(["analytics"]);
  stub = stubApi({
    "GET /site-infrastructure/vocabulary": VOCAB,
    "GET /sites/s1/infrastructure": tree(),
    "GET /bi/devices": {
      total: 1,
      items: [{ device_id: "d1", device_tag: "CH1", category: "hvac", device_type: "chiller", points: 2 }],
    },
    "GET /bi/points": {
      total: 2,
      latest_lookback_minutes: 15,
      items: [
        { point_id: "p1", point_tag: "OWT", device_tag: "CH1", type: "num" },
        { point_id: "p2", point_tag: "IWT", device_tag: "CH1", type: "num" },
      ],
    },
    "PUT /sites/s1/infrastructure/*": CHILLER,
    "POST /sites/s1/infrastructure/*": {},
  });
});

const render = (props: { initialEquipmentId?: string } = {}) => {
  renderWithProviders(<InfraDesigner siteId="s1" {...props} />);
  return userEvent.setup();
};

async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
  await user.click(screen.getByRole("button", { name: field }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);

describe("the pickers", () => {
  it("offer the system kinds the server's vocabulary names — including ones no UI list knows", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "New system" }));
    await user.click(screen.getByRole("button", { name: "Kind" }));

    expect(optionNames()).toEqual(["Chilled-water plant loop", "District cooling tie-in", "Power chain"]);

    await user.click(screen.getByRole("option", { name: "District cooling tie-in" }));
    await user.type(screen.getByLabelText(/System name/), "Tie-in 1");
    await user.click(screen.getByRole("button", { name: "Create system" }));

    await waitFor(() =>
      expect(stub.body("POST /sites/s1/infrastructure/systems")).toEqual({
        name: "Tie-in 1",
        kind: "district_tiein",
        description: null,
      }),
    );
  });

  it("offer only the classes whose vocabulary entry admits the system's kind", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^Plant A/ }));
    await user.click(screen.getByRole("button", { name: "Add equipment" }));
    await user.click(screen.getByRole("button", { name: "Class" }));

    // A DG set belongs in a power system, and the server would refuse it here.
    expect(optionNames()).toEqual(["Chiller", "Absorption chiller", "Primary CHW pump"]);
  });
});

describe("a class", () => {
  it("offers only its own slots and design facts", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^PP-01/ }));

    expect(screen.getByTestId("slot-run_status")).toBeInTheDocument();
    expect(screen.getByTestId("slot-kw")).toBeInTheDocument();
    expect(screen.queryByTestId("slot-chws")).not.toBeInTheDocument();

    expect(screen.getByTestId("fact-make")).toBeInTheDocument();
    expect(screen.getByTestId("fact-kw_rated")).toBeInTheDocument();
    // A pump has no TR and no ΔT band.
    expect(screen.queryByTestId("fact-tr")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fact-design_dt_min")).not.toBeInTheDocument();
  });

  it("prints a fact never recorded as missing, not as zero", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^PP-01/ }));

    const rated = screen.getByTestId("fact-kw_rated");
    expect(rated).toHaveTextContent("not recorded");
    expect(rated).not.toHaveTextContent("0");
  });
});

describe("binding a slot", () => {
  it("picks the point from the site's devices and sends both tags", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^CH-01/ }));
    await user.click(screen.getByRole("button", { name: "Bind CHW supply (leaving) temperature" }));

    await pick(user, "Device", "CH1 · chiller");
    await pick(user, "Point", "OWT");
    await user.click(screen.getByRole("button", { name: "Bind" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/infrastructure/equipment/e1/slots/chws")).toEqual({
        device_tag: "CH1",
        point_tag: "OWT",
      }),
    );
    // The device list was the SITE's.
    expect(stub.matching("GET /bi/devices")[0]!.search.get("site_id")).toBe("s1");
  });

  it("shows a 409's own sentence when the point already feeds another slot", async () => {
    const msg = "point CH1 / OWT is already bound to TEST-CH-1.kw; a point feeds one slot, or it is counted twice";
    stub.set({ "PUT /sites/s1/infrastructure/*": () => httpError(409, msg, "CONFLICT") });
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^CH-01/ }));
    await user.click(screen.getByRole("button", { name: "Bind CHW supply (leaving) temperature" }));
    await pick(user, "Device", "CH1 · chiller");
    await pick(user, "Point", "OWT");
    await user.click(screen.getByRole("button", { name: "Bind" }));

    expect(await within(screen.getByTestId("slot-chws")).findByRole("alert")).toHaveTextContent(msg);
  });
});

describe("the design facts", () => {
  it("send every other recorded fact back unchanged when one is edited", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^CH-01/ }));
    await user.click(screen.getByRole("button", { name: "Edit design facts" }));

    const tr = screen.getByLabelText("Rated capacity (refrigeration tons)");
    await user.clear(tr);
    await user.type(tr, "400");
    await user.click(screen.getByRole("button", { name: "Save facts" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/infrastructure/equipment/e1/design")).toEqual({
        design: { make: "York", tr: 400, design_dt_min: 5, design_dt_max: 7 },
      }),
    );
  });

  it("will not clear a recorded fact without asking first", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^CH-01/ }));
    await user.click(screen.getByRole("button", { name: "Edit design facts" }));
    await user.clear(screen.getByLabelText("Make"));
    await user.click(screen.getByRole("button", { name: "Save facts" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Saving clears Make");
    expect(stub.matching("PUT /sites/s1/infrastructure/*")).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Clear and save" }));
    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/infrastructure/equipment/e1/design")).toEqual({
        design: { make: null, tr: 350, design_dt_min: 5, design_dt_max: 7 },
      }),
    );
  });

  it("flags a chiller with no ΔT band on file in the tree", async () => {
    stub.set({ "GET /sites/s1/infrastructure": tree([equipment({ design: { tr: 350 } }), PUMP]) });
    render();

    const row = await screen.findByRole("button", { name: /^CH-01/ });
    expect(row).toHaveTextContent("no ΔT band");
    // A pump's class has no band, so it is not missing one.
    expect(screen.getByRole("button", { name: /^PP-01/ })).not.toHaveTextContent("no ΔT band");
  });
});

describe("the schedule import", () => {
  const PLAN = {
    dry_run: true,
    sheet: "Equipment_Schedule",
    rows_read: 4,
    ignored_columns: ["Remarks"],
    systems: [{ name: "Plant A", kind: "chw_plant", reused: true, system_id: "sys1" }],
    equipment: [
      {
        tag: "CH-02",
        system: "Plant A",
        equipment_class: "chiller",
        name: null,
        design: { tr: 300 },
        design_units: { tr: "TR" },
        slots: [{ slot: "chws", device_tag: "CH2", point_tag: "OWT" }],
        rows: [2],
        equipment_id: null,
      },
    ],
    skipped: [
      { row: 3, equipment_tag: "CH-01", slot: null, reason: "exists", message: "equipment CH-01 already exists on this site" },
      { row: 4, equipment_tag: "CT-01", slot: "tr", reason: "invalid", message: "a cooling_tower has no 'chws' slot" },
    ],
    counts: { systems_created: 0, equipment_created: 1, slots_created: 1, rows_skipped: 2 },
  };

  it("previews first, shows each skipped row and why, and writes only on the second press", async () => {
    // The wildcard POST is matched first, so the import answer replaces it.
    stub.set({ "POST /sites/s1/infrastructure/*": PLAN });
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Import I/O schedule" }));

    expect(screen.queryByRole("button", { name: /^Apply/ })).not.toBeInTheDocument();

    const file = new File(["xlsx"], "schedule.xlsx");
    await user.upload(screen.getByLabelText(/Schedule file/), file);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const skipped = await screen.findByRole("list", { name: "Skipped rows" });
    expect(within(skipped).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "row 3existsCH-01equipment CH-01 already exists on this site",
      "row 4invalidCT-01.tra cooling_tower has no 'chws' slot",
    ]);
    const calls = () => stub.matching("POST /sites/s1/infrastructure/import");
    expect(calls().map((c) => c.search.get("dry_run"))).toEqual(["true"]);

    await user.click(screen.getByRole("button", { name: "Apply: 1 equipment, 1 slot(s)" }));

    await waitFor(() => expect(calls().map((c) => c.search.get("dry_run"))).toEqual(["true", "false"]));
  });
});

describe("a viewer without bi.manage", () => {
  it("is offered no control that writes", async () => {
    // `sites.update` is the key this designer USED to write under. Holding it
    // must open nothing now: the registry is BI configuration.
    perms.granted = new Set(["bi.read", "sites.read", "sites.update"]);
    const user = render();
    await user.click(await screen.findByRole("button", { name: /^CH-01/ }));

    expect(screen.getByTestId("fact-tr")).toHaveTextContent("350");
    for (const name of [
      "New system",
      "Import I/O schedule",
      "Edit equipment",
      "Delete equipment",
      "Edit design facts",
      /^Bind /,
      /^Rebind /,
      /^Unbind /,
      /^Remove the /,
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: /^Plant A/ }));
    for (const name of ["Add equipment", "Edit system", "Delete system"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

describe("the gate it rides", () => {
  it("is BI's, not Sites': sites.read + sites.update without bi.read reads nothing", async () => {
    perms.granted = new Set(["sites.read", "sites.update"]);
    render();

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    expect(stub.matching("GET /sites/s1/infrastructure")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "New system" })).not.toBeInTheDocument();
  });

  it("needs the analytics module as well as bi.read", async () => {
    perms.modules = new Set();
    render();

    expect(await screen.findByText(/Needs/)).toBeInTheDocument();
    expect(stub.matching("GET /sites/s1/infrastructure")).toHaveLength(0);
  });

  it("writes under bi.manage", async () => {
    render();
    expect(await screen.findByRole("button", { name: "New system" })).toBeInTheDocument();
  });
});
