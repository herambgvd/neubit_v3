/**
 * The equipment drawing is where a device becomes a machine BI judges, so what
 * it may SEND is the substance here:
 *
 *   • a proposal is saved only on a press, with the slots the person left
 *     ticked — a slot whose reading the checks flagged starts UNTICKED;
 *   • the system of that kind is created when the building has none;
 *   • "Save all like this" saves the other CLEAN proposals of that type, never
 *     one with a warning;
 *   • half a ΔT band is refused before anything is sent;
 *   • a saved box changes its feeder, its points and its nameplate in place,
 *     and the nameplate PUT still sends every other fact back unchanged;
 *   • an import is a dry run first; a restate says what it restated or that it
 *     failed;
 *   • a viewer without bi.manage sees the drawing and no control that writes.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EquipmentPublic, InfraVocabulary, InfrastructureTree } from "@/lib/types";
import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import PlantCanvas from "./PlantCanvas";

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toasts.success(...a), error: (...a: unknown[]) => toasts.error(...a) },
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ can: () => true, hasModule: () => true }),
}));

const VOCAB: InfraVocabulary = {
  system_kinds: [
    { key: "chw_plant", label: "Chilled-water plant loop", description: "" },
    { key: "power", label: "Power chain", description: "" },
  ],
  equipment_classes: [
    {
      key: "chiller",
      label: "Chiller",
      system_kinds: ["chw_plant"],
      slots: ["chws", "chwr", "kw"],
      facts: ["make", "tr", "design_dt_min", "design_dt_max"],
    },
    { key: "energy_meter", label: "Energy meter", system_kinds: ["power"], slots: ["kw", "kwh"], facts: [] },
  ],
  slots: [
    { key: "chws", dimension: "temperature", label: "CHW supply (leaving) temperature", role: "outlet_water_temp" },
    { key: "chwr", dimension: "temperature", label: "CHW return (entering) temperature", role: "inlet_water_temp" },
    { key: "kw", dimension: "power", label: "Active power", role: "active_power" },
    { key: "kwh", dimension: "energy", label: "Energy", role: "active_energy" },
  ],
  design_facts: [
    { key: "make", type: "text", unit: null, label: "Make" },
    { key: "tr", type: "number", unit: "TR", label: "Rated capacity (refrigeration tons)" },
    { key: "design_dt_min", type: "number", unit: "K", label: "Design CHW ΔT, lower bound" },
    { key: "design_dt_max", type: "number", unit: "K", label: "Design CHW ΔT, upper bound" },
  ],
};

const T = "2026-09-20T00:00:00Z";

// ── core's registry ──────────────────────────────────────────────────────────
const pub = (over: Partial<EquipmentPublic>): EquipmentPublic => ({
  equipment_id: "e1",
  site_id: "s1",
  system_id: "sys-p",
  tag: "MAIN",
  name: null,
  equipment_class: "energy_meter",
  design: {},
  design_units: {},
  slots: [],
  created_at: T,
  updated_at: T,
  ...over,
});
const MAIN = pub({ slots: [{ slot: "kw", device_tag: "B2_Main Incomer", point_tag: "TOTKW", bound: true }] });
const DB = pub({ equipment_id: "e2", tag: "DB-1", slots: [{ slot: "kw", device_tag: "DB1", point_tag: "KW", bound: true }] });
const CH = pub({
  equipment_id: "e5",
  system_id: "sys-c",
  tag: "CH-01",
  equipment_class: "chiller",
  design: { make: "York", tr: 350, design_dt_min: 5, design_dt_max: 7 },
  design_units: { tr: "TR", design_dt_min: "K", design_dt_max: "K" },
  slots: [{ slot: "chwr", device_tag: "CH1", point_tag: "IWT", bound: true }],
});

const system = (id: string, kind: string, equipment: EquipmentPublic[]) => ({
  system_id: id, site_id: "s1", name: id, kind, description: null, created_at: T, updated_at: T, equipment,
});
const TREE: InfrastructureTree = {
  site_id: "s1",
  systems: [system("sys-p", "power", [MAIN, DB]), system("sys-c", "chw_plant", [CH])],
};

// ── the reporting store's view of it ─────────────────────────────────────────
const plantOf = (e: EquipmentPublic, value: number, fedBy: string | null = null) => ({
  equipment_id: e.equipment_id,
  tag: e.tag,
  name: null,
  equipment_class: e.equipment_class,
  system_id: e.system_id,
  fed_by_id: fedBy,
  design: e.design,
  design_units: {},
  readiness: "reporting",
  readiness_counts: {},
  metrics: {},
  slots: e.slots.map((s) => ({
    slot: s.slot,
    binding: { device_tag: s.device_tag, point_tag: s.point_tag },
    latest: { t: T, value, text: null },
  })),
});
const PLANT = {
  site_id: "s1",
  systems: [{ equipment: [plantOf(MAIN, 410), plantOf(DB, 12), plantOf(CH, 11.5)] }],
  unassigned_equipment: [],
};

// ── the proposals ────────────────────────────────────────────────────────────
const slot = (s: string, tag: string, value: number, warning: string | null = null) => ({
  slot: s, point_tag: tag, value, at: T, alternatives: 0, warning,
});
const dev = (tag: string, cls: string | null, kind: string | null, over: object = {}) => ({
  device_tag: tag, points: 6, last_seen_at: T, quiet: false, fragment: false, equipment_class: cls,
  system_kind: kind, why: "named a chiller", slots: [], warnings: [], registered: null, feeder: null, ...over,
});
const SUGGESTIONS = {
  devices: [
    dev("1F York Chiller01", "chiller", "chw_plant", {
      slots: [slot("chwr", "1FYC1_IWT", 12), slot("chws", "1FYC1_OWT", 7), slot("kw", "1FYC1_EM_kW", 2312, "looks like an energy counter")],
    }),
    dev("2F York Chiller01", "chiller", "chw_plant", { slots: [slot("chwr", "2FYC1_IWT", 13), slot("chws", "2FYC1_OWT", 8)] }),
    dev("3F York Chiller01", "chiller", "chw_plant", { slots: [slot("chwr", "3FYC1_IWT", 13), slot("chws", "3FYC1_OWT", 8)] }),
    dev("4F_Incomer1_EM", "energy_meter", "power", {
      slots: [slot("kw", "KW", 40)],
      feeder: { suggested: "B2_Main Incomer", candidates: ["B2_Main Incomer"], reason: "the one main incomer" },
    }),
    dev("B2_Main Incomer", "energy_meter", "power", { registered: { equipment_tag: "MAIN", equipment_id: "e1" } }),
    dev("gateway", null, null, { fragment: true }),
  ],
  totals: { devices: 6, machines: 5, unknown: 0, fragments: 1, registered: 1, unplaced_elsewhere: 28 },
};

let stub: ApiStub;
let mayWrite = true;

beforeEach(() => {
  mayWrite = true;
  toasts.success.mockClear();
  toasts.error.mockClear();
  stub = stubApi({
    "GET /bi/sites/s1/plant": PLANT,
    "GET /bi/sites/s1/equipment/suggestions": SUGGESTIONS,
    "GET /sites/s1/infrastructure": TREE,
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
    "POST /sites/s1/infrastructure/*": (req: { url: string }) =>
      req.url.endsWith("/systems")
        ? { system_id: "sys-new", site_id: "s1", name: "Power chain", kind: "power" }
        : req.url.endsWith("/republish")
          ? { site_id: "s1", systems: 2, equipment: 3 }
          : { equipment_id: "new" },
    "PATCH /sites/s1/infrastructure/*": {},
    "PUT /sites/s1/infrastructure/*": CH,
    "DELETE /sites/s1/infrastructure/*": {},
  });
});

const render = (props: { initialEquipmentId?: string; initialImporting?: boolean } = {}) => {
  renderWithProviders(<PlantCanvas siteId="s1" vocab={VOCAB} mayWrite={mayWrite} {...props} />);
  return userEvent.setup();
};
const posts = (tail: string) => stub.matching("POST /sites/s1/infrastructure/*").filter((c) => c.url.endsWith(tail));

describe("the drawing", () => {
  it("draws saved equipment solid, proposals dashed, and counts each system", async () => {
    render();
    expect(await screen.findByRole("button", { name: "1F York Chiller01 — suggested" })).toBeInTheDocument();
    // Only the return is bound: no ΔT is invented from half the pair.
    expect(screen.getByRole("button", { name: "CH-01" })).not.toHaveTextContent("°C");
    expect(screen.getByRole("button", { name: "1F York Chiller01 — suggested" })).toHaveTextContent("5 °C ΔT");
    expect(screen.getByRole("tab", { name: /Chilled water/ })).toHaveTextContent("1/4");
    expect(screen.getByRole("tab", { name: /Power/ })).toHaveTextContent("2/3");
  });

  it("leaves leftovers off the drawing and says devices are in no building", async () => {
    render();
    await screen.findByRole("button", { name: "CH-01" });
    expect(screen.queryByRole("button", { name: /gateway/ })).not.toBeInTheDocument();
    expect(screen.getByText(/1 not machines/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /28 devices are in no building yet/ })).toBeInTheDocument();
  });

  it("hangs a proposal under the saved feeder the engine named", async () => {
    const user = render();
    await user.click(await screen.findByRole("tab", { name: /Power/ }));
    await user.click(screen.getByRole("button", { name: "4F_Incomer1_EM — suggested" }));
    expect(screen.getByLabelText("Fed by")).toHaveValue("e1");
    expect(screen.getByRole("button", { name: "MAIN" })).toHaveTextContent("410 kW");
  });
});

describe("saving a proposal", () => {
  it("sends the ticked slots, never a flagged one unless ticked, and the nameplate typed", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "1F York Chiller01 — suggested" }));

    const pop = screen.getByRole("dialog", { name: "1F York Chiller01" });
    expect(within(pop).getByRole("checkbox", { name: "Save kw" })).not.toBeChecked();
    expect(within(pop).getByRole("checkbox", { name: "Save chwr" })).toBeChecked();

    await user.type(within(pop).getByLabelText("Capacity (TR)"), "350");
    await user.click(within(pop).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts("/equipment")).toHaveLength(1));
    expect(posts("/equipment")[0].body).toEqual({
      system_id: "sys-c",
      tag: "1F York Chiller01",
      equipment_class: "chiller",
      slots: [
        { slot: "chwr", device_tag: "1F York Chiller01", point_tag: "1FYC1_IWT" },
        { slot: "chws", device_tag: "1F York Chiller01", point_tag: "1FYC1_OWT" },
      ],
      fed_by_id: null,
      design: { tr: 350 },
    });
    // The building already had a chilled-water system.
    expect(posts("/systems")).toHaveLength(0);
  });

  it("refuses half a ΔT band before sending anything", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "2F York Chiller01 — suggested" }));
    await user.type(screen.getByLabelText("Design ΔT low (K)"), "5");

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Give both ends of the ΔT band, or neither.")).toBeInTheDocument();
    expect(posts("/equipment")).toHaveLength(0);
  });

  it("creates the system of that kind when the building has none, and hangs it under its feeder", async () => {
    stub.set({ "GET /sites/s1/infrastructure": { site_id: "s1", systems: [system("sys-c", "chw_plant", [CH])] } });
    const user = render();
    await user.click(await screen.findByRole("tab", { name: /Power/ }));
    await user.click(screen.getByRole("button", { name: "4F_Incomer1_EM — suggested" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts("/equipment")).toHaveLength(1));
    expect(posts("/systems")[0].body).toEqual({ name: "Power chain", kind: "power" });
    expect(posts("/equipment")[0].body).toMatchObject({ system_id: "sys-new", fed_by_id: "e1" });
  });

  it("saves the other clean proposals of the type with 'like this', never a flagged one", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "2F York Chiller01 — suggested" }));
    await user.click(screen.getByRole("button", { name: "Save all 2 like this" }));

    await waitFor(() => expect(posts("/equipment")).toHaveLength(2));
    expect(posts("/equipment").map((c) => c.body?.tag)).toEqual(["2F York Chiller01", "3F York Chiller01"]);
  });

  it("shows the server's own sentence when a save is refused", async () => {
    stub.set({
      "POST /sites/s1/infrastructure/*": () => httpError(409, "equipment tag already used on this site", "CONFLICT"),
    });
    const user = render();
    await user.click(await screen.findByRole("button", { name: "2F York Chiller01 — suggested" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/equipment tag already used on this site/)).toBeInTheDocument();
  });
});

describe("a saved box", () => {
  it("changes what feeds it in place", async () => {
    const user = render();
    await user.click(await screen.findByRole("tab", { name: /Power/ }));
    await user.click(screen.getByRole("button", { name: "DB-1" }));
    await user.selectOptions(screen.getByLabelText("Fed by"), "e1");

    await waitFor(() =>
      expect(stub.body("PATCH /sites/s1/infrastructure/equipment/e2")).toEqual({ fed_by_id: "e1" }),
    );
  });

  it("is removed only after a second press", async () => {
    const user = render();
    await user.click(await screen.findByRole("tab", { name: /Power/ }));
    await user.click(screen.getByRole("button", { name: "DB-1" }));
    await user.click(screen.getByRole("button", { name: "Remove from the registry" }));
    expect(stub.matching("DELETE /sites/s1/infrastructure/*")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(stub.matching("DELETE /sites/s1/infrastructure/equipment/e2")).toHaveLength(1));
  });

  it("edits one nameplate fact and sends every other one back unchanged", async () => {
    const user = render({ initialEquipmentId: "e5" });
    await user.click(await screen.findByRole("button", { name: "Edit design facts" }));
    const tr = screen.getByLabelText("Rated capacity (refrigeration tons)");
    await user.clear(tr);
    await user.type(tr, "400");
    await user.click(screen.getByRole("button", { name: "Save facts" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/infrastructure/equipment/e5/design")).toEqual({
        design: { make: "York", tr: 400, design_dt_min: 5, design_dt_max: 7 },
      }),
    );
  });

  it("rebinds a slot to a point of the site's devices, sending both tags", async () => {
    const user = render({ initialEquipmentId: "e5" });
    await user.click(await screen.findByText("Change which point feeds a slot"));
    await user.click(screen.getByRole("button", { name: "Bind CHW supply (leaving) temperature" }));
    await user.click(screen.getByRole("button", { name: "Device" }));
    await user.click(await screen.findByRole("option", { name: "CH1 · chiller" }));
    await user.click(screen.getByRole("button", { name: "Point" }));
    await user.click(await screen.findByRole("option", { name: "OWT" }));
    await user.click(screen.getByRole("button", { name: "Bind" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/infrastructure/equipment/e5/slots/chws")).toEqual({
        device_tag: "CH1",
        point_tag: "OWT",
      }),
    );
  });
});

describe("the import", () => {
  it("previews first and writes only on the second press", async () => {
    const PLAN = {
      dry_run: true, sheet: "S", rows_read: 1, ignored_columns: [], systems: [],
      equipment: [{ tag: "CH-02", system: "sys-c", equipment_class: "chiller", name: null, design: {}, design_units: {}, slots: [{ slot: "chws", device_tag: "CH2", point_tag: "OWT" }], rows: [2], equipment_id: null }],
      skipped: [],
      counts: { systems_created: 0, equipment_created: 1, slots_created: 1, rows_skipped: 0 },
    };
    stub.set({ "POST /sites/s1/infrastructure/*": PLAN });
    const user = render({ initialImporting: true });

    await user.upload(await screen.findByLabelText(/Schedule file/), new File(["xlsx"], "s.xlsx"));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const calls = () => stub.matching("POST /sites/s1/infrastructure/import");
    await waitFor(() => expect(calls().map((c) => c.search.get("dry_run"))).toEqual(["true"]));

    await user.click(await screen.findByRole("button", { name: "Apply: 1 equipment, 1 slot(s)" }));
    await waitFor(() => expect(calls().map((c) => c.search.get("dry_run"))).toEqual(["true", "false"]));
  });
});

describe("restating the plant to analytics", () => {
  it("asks core to republish THIS building and says what it restated", async () => {
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Restate this building's plant to analytics" }));
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());
    expect(posts("/republish")).toHaveLength(1);
    expect(toasts.success.mock.calls[0][1].description).toMatch(/2 system\(s\) and 3 machine\(s\)/);
  });

  it("says it failed rather than implying analytics has been repaired", async () => {
    stub.set({ "POST /sites/s1/infrastructure/*": () => httpError(502, "the bus is unreachable") });
    const user = render();
    await user.click(await screen.findByRole("button", { name: "Restate this building's plant to analytics" }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.error.mock.calls[0][0]).toMatch(/the bus is unreachable/);
    expect(toasts.success).not.toHaveBeenCalled();
  });
});

describe("a viewer without bi.manage", () => {
  it("sees the drawing and the values, and no control that writes", async () => {
    mayWrite = false;
    const user = render();
    await user.click(await screen.findByRole("button", { name: "1F York Chiller01 — suggested" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("1FYC1_IWT");
    for (const name of ["Save", /^Save all/, "Import I/O schedule", "Restate this building's plant to analytics"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "CH-01" }));
    expect(screen.queryByRole("button", { name: "Remove from the registry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit design facts" })).not.toBeInTheDocument();
  });
});
