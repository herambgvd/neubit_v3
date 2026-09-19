/**
 * L3 PLANT. One building's plant, drawn, and coloured by DATA READINESS.
 *
 * The failures this screen can make are all one shape — a machine drawn as
 * something it is not known to be:
 *
 *   • an empty registry rendered as a blank page instead of the door into
 *     Setup → Equipment for this building;
 *   • a chiller whose slots are not reporting drawn green (or red) because a
 *     metric said something — readiness is the colour, a metric never is;
 *   • a metric computed over an input that is not reporting shown as a verdict;
 *   • a refusal shown as 0, or as nothing;
 *   • a request made for a caller who may not read Building Intelligence.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BiPlant, BiPlantEquipment, BiPlantMetricDef, BiPlantSlot } from "@/lib/types";
import { httpError, stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import Plant from "./Plant";
import { READINESS, READINESS_STYLE } from "./plant/readiness";
import { infraDesignerHref, infraImportHref } from "./setup/routes";

const nav = { params: new URLSearchParams("site=site-1") };
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));

const perms = { granted: new Set<string>(), modules: new Set<string>() };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    can: (p: string) => perms.granted.has(p),
    hasModule: (m: string) => perms.modules.has(m),
  }),
}));

const T = "2026-09-19T10:00:00Z";

const METRICS: BiPlantMetricDef[] = [
  { metric: "chw_delta_t", version: 1, label: "CHW ΔT", precision: 1, equipment_class: "chiller", slots: ["chwr", "chws"], resolution: "1m" },
  { metric: "chw_delta_t_in_band", version: 2, label: "ΔT in design band", precision: 0, equipment_class: "chiller", slots: ["chwr", "chws"], resolution: "1m" },
  { metric: "chiller_kw_per_tr", version: 1, label: "Chiller kW/TR", precision: 2, equipment_class: "chiller", slots: ["kw", "load"], resolution: "1m" },
];

const slot = (over: Partial<BiPlantSlot> & { slot: string }): BiPlantSlot => ({
  label: over.slot,
  dimension: "temperature",
  binding: { device_tag: "GW-1", point_tag: over.slot.toUpperCase() },
  readiness: "reporting",
  reason: null,
  point: {
    point_id: `p-${over.slot}`,
    point_tag: over.slot.toUpperCase(),
    device_tag: "GW-1",
    unit: "degC",
    unit_confirmed: true,
    last_seen_at: T,
  },
  latest: { t: T, value: 7.1, text: null },
  candidates: [],
  ghosts: [],
  declared: true,
  required_by: [],
  ...over,
});

const counts = (slots: BiPlantSlot[]) =>
  Object.fromEntries(READINESS.map((s) => [s, slots.filter((x) => x.readiness === s).length]));

const chiller = (over: Partial<BiPlantEquipment> & { equipment_id: string; tag: string }): BiPlantEquipment => {
  const slots = over.slots ?? [slot({ slot: "chws", required_by: ["chw_delta_t"] }), slot({ slot: "chwr", required_by: ["chw_delta_t"] })];
  return {
    name: null,
    equipment_class: "chiller",
    system_id: "sys-1",
    design: {},
    design_units: {},
    readiness: "reporting",
    readiness_counts: counts(slots),
    metrics: {},
    ...over,
    slots,
  };
};

const plant = (equipment: BiPlantEquipment[], over: Partial<BiPlant> = {}): BiPlant => ({
  site_id: "site-1",
  site_name: "Aeon Tower",
  window: { start: T, end: T },
  readiness_states: [...READINESS],
  totals: counts(equipment.flatMap((e) => e.slots)),
  metrics: METRICS,
  systems: equipment.length
    ? [{ system_id: "sys-1", name: "Plant A", kind: "chw_plant", description: null, readiness: "reporting", equipment }]
    : [],
  unassigned_equipment: [],
  ...over,
});

const EMPTY = plant([]);

let stub: ApiStub;

function serve(body: BiPlant | (() => unknown)) {
  stub = stubApi({
    "GET /bi/sites/site-1/plant": body,
    // The L3 gate strip's reads. A clean, quiet estate: its own behaviour is
    // GateStrip.test.tsx's business.
    "GET /bi/summary": {
      total_points: 4, total_registers: 4, total_points_reporting: 4, fresh_minutes: 15,
      sites: [{ site_id: "site-1", site_name: "Aeon Tower", score: 60, points: 4, categories: [] }],
      categories: [],
    },
    "GET /bi/points/ghosts": { groups: [], resurrected: [], fresh_minutes: 15 },
    "GET /bi/units/patterns": { patterns: [], totals: { points: 4, matched: 4, unmatched: 0, eligible: 0, already_confirmed: 4 } },
    "GET /bi/points/roles/orphans": { orphans: [], total: 0 },
    "GET /bi/alerts": { available: true, items: [] },
    "GET /bi/rating/sites": { items: [] },
  });
}

beforeEach(() => {
  nav.params = new URLSearchParams("site=site-1");
  perms.granted = new Set(["bi.read"]);
  perms.modules = new Set(["analytics"]);
  serve(EMPTY);
});

const glyph = (tag: string) => screen.findByRole("button", { name: new RegExp(`^${tag} —`) });
const frameOf = (el: HTMLElement) => el.querySelector('[data-part="frame"]')!;

describe("an empty registry", () => {
  it("sends the operator to Setup → Equipment for THIS building", async () => {
    renderWithProviders(<Plant />);

    const link = await screen.findByRole("link", { name: /Describe it in Setup → Equipment/ });
    expect(link).toHaveAttribute("href", infraDesignerHref("site-1"));
    expect(link.getAttribute("href")).toContain("site=site-1");
    // Nothing is drawn: there is nothing to draw.
    expect(screen.queryByRole("group", { name: /schematic/ })).not.toBeInTheDocument();
  });

  it("treats a building the store has never heard of the same way, not as a failure", async () => {
    serve(() => httpError(404, "no such site in this tenant's reporting store"));
    renderWithProviders(<Plant />);

    expect(await screen.findByText(/has no record of this building yet/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Describe it in Setup → Equipment/ })).toHaveAttribute(
      "href",
      infraDesignerHref("site-1"),
    );
  });
});

describe("readiness is the colour", () => {
  it("draws each of the five states distinctly — colour, dash and word", async () => {
    const eqs = READINESS.map((state, i) =>
      chiller({
        equipment_id: `e${i}`,
        tag: `CH-${i}`,
        readiness: state,
        slots: [slot({ slot: "chws", readiness: state })],
      }),
    );
    serve(plant(eqs));
    renderWithProviders(<Plant />);

    const seen = new Set<string>();
    for (const [i, state] of READINESS.entries()) {
      const g = await glyph(`CH-${i}`);
      expect(g).toHaveAttribute("data-readiness", state);
      const frame = frameOf(g);
      expect(frame.getAttribute("stroke")).toBe(READINESS_STYLE[state].color);
      expect(within(g).getByText(READINESS_STYLE[state].label.toUpperCase())).toBeInTheDocument();
      seen.add(`${frame.getAttribute("stroke")}|${frame.getAttribute("stroke-dasharray") ?? ""}`);
    }
    expect(seen.size).toBe(5);
    // Hue alone never carries the state: five colours AND five words.
    expect(new Set(READINESS.map((s) => READINESS_STYLE[s].color)).size).toBe(5);
    expect(new Set(READINESS.map((s) => READINESS_STYLE[s].label)).size).toBe(5);
  });

  it("colours equipment by its readiness, never by what a metric says", async () => {
    serve(
      plant([
        // A metric came back fine, but the equipment's slots are silent.
        chiller({
          equipment_id: "e1",
          tag: "CH-1",
          readiness: "silent",
          metrics: { chw_delta_t_in_band: { status: "ok", value: 100, unit: "%", metric: "chw_delta_t_in_band", version: 2 } },
        }),
        // Every slot reporting, and the band metric refused.
        chiller({
          equipment_id: "e2",
          tag: "CH-2",
          readiness: "reporting",
          metrics: {
            chw_delta_t_in_band: {
              status: "missing_fact", value: null, metric: "chw_delta_t_in_band", version: 2,
              reason: "input `dt_min`: CH-2 has no `design_dt_min` recorded",
            },
          },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    expect(frameOf(await glyph("CH-1")).getAttribute("stroke")).toBe(READINESS_STYLE.silent.color);
    expect(frameOf(await glyph("CH-2")).getAttribute("stroke")).toBe(READINESS_STYLE.reporting.color);
  });

  it("puts every count beside the action that changes it", async () => {
    const slots = [
      slot({ slot: "chws", readiness: "unbound", binding: null, point: null, latest: null }),
      slot({ slot: "chwr", readiness: "silent", latest: null }),
    ];
    serve(plant([chiller({ equipment_id: "e1", tag: "CH-1", readiness: "silent", slots })]));
    renderWithProviders(<Plant />);

    const legend = await screen.findByLabelText("Readiness legend");
    const unbound = legend.querySelector('[data-state="unbound"]')!;
    // Unbound is fixed in the designer — the count is the door.
    expect(unbound.tagName).toBe("A");
    expect(unbound).toHaveAttribute("href", infraDesignerHref("site-1"));
    // Silent is fixed at the device: no door here, and it says so.
    const silent = legend.querySelector('[data-state="silent"]')!;
    expect(silent.tagName).toBe("SPAN");
    expect(silent.getAttribute("title")).toMatch(/device/);
  });
});

describe("metrics", () => {
  it("does not give a verdict over an input that is not reporting", async () => {
    // Contrived on purpose: the value came back, the input is silent. The
    // screen must not print the number as if it meant something.
    serve(
      plant([
        chiller({
          equipment_id: "e1",
          tag: "CH-1",
          readiness: "silent",
          slots: [
            slot({ slot: "chws", readiness: "silent", latest: null, required_by: ["chw_delta_t"] }),
            slot({ slot: "chwr", required_by: ["chw_delta_t"] }),
          ],
          metrics: { chw_delta_t: { status: "ok", value: 5.3, unit: "K", metric: "chw_delta_t", version: 1, arithmetic: "chwr - chws = 5.3" } },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    const g = await glyph("CH-1");
    const line = g.querySelector('[data-metric="chw_delta_t"]')!;
    expect(line).toHaveAttribute("data-metric-kind", "unknown");
    expect(line.textContent).toContain("not known");
    expect(g.textContent).not.toContain("5.3");

    await userEvent.click(g);
    const row = (await screen.findByText("CHW ΔT")).closest("li")!;
    expect(row).toHaveTextContent("not known");
    expect(row).not.toHaveTextContent("5.3");
  });

  it("prints a refusal's reason, never 0 and never a blank", async () => {
    serve(
      plant([
        chiller({
          equipment_id: "e1",
          tag: "CH-1",
          readiness: "unbound",
          slots: [slot({ slot: "kw", readiness: "unbound", binding: null, point: null, latest: null, required_by: ["chiller_kw_per_tr"] })],
          metrics: {
            chiller_kw_per_tr: {
              status: "slot_unbound", value: null, metric: "chiller_kw_per_tr", version: 1,
              reason: "input `kw` on CH-1: slot `kw` (Active power) is not bound to a point. Bind it on the equipment.",
            },
          },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    const g = await glyph("CH-1");
    const line = g.querySelector('[data-metric="chiller_kw_per_tr"]')!;
    expect(line.textContent).toContain("slot unbound");
    expect(line.textContent).not.toMatch(/\b0(\.0+)?\b/);

    await userEvent.click(g);
    const row = (await screen.findByText("Chiller kW/TR")).closest("li")!;
    expect(row).toHaveTextContent("refused · slot unbound");
    expect(row).toHaveTextContent(/is not bound to a point/);
    expect(within(row).getByRole("link", { name: /Bind the slot on CH-1/ })).toHaveAttribute(
      "href",
      infraDesignerHref("site-1", "e1"),
    );
  });

  it("links a chiller refusing for its missing design band to THAT chiller in the designer", async () => {
    serve(
      plant([
        chiller({
          equipment_id: "e7",
          tag: "CH-7",
          metrics: {
            chw_delta_t_in_band: {
              status: "missing_fact", value: null, metric: "chw_delta_t_in_band", version: 2,
              reason: "input `dt_min`: CH-7 has no `design_dt_min` (Design CHW ΔT, lower bound) recorded — record it on the equipment",
            },
          },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    await userEvent.click(await glyph("CH-7"));
    const row = (await screen.findByText("ΔT in design band")).closest("li")!;
    const fix = within(row).getByRole("link", { name: /Record it on CH-7/ });
    expect(fix).toHaveAttribute("href", infraDesignerHref("site-1", "e7"));
    expect(fix.getAttribute("href")).toContain("equipment=e7");
  });
});

describe("selection", () => {
  it("opens the pressed equipment's slots and metrics", async () => {
    serve(
      plant([
        chiller({ equipment_id: "e1", tag: "CH-1" }),
        chiller({
          equipment_id: "e2",
          tag: "CH-2",
          readiness: "unbound",
          slots: [
            slot({ slot: "chws", latest: { t: T, value: 6.8, text: null } }),
            slot({
              slot: "chwr",
              readiness: "unbound",
              binding: null,
              point: null,
              latest: null,
              declared: false,
              reason: "slot `chwr` (CHW return) is not bound to a point — bind it on the equipment in Setup",
            }),
          ],
          metrics: { chw_delta_t: { status: "ok", value: 5.24, unit: "K", metric: "chw_delta_t", version: 1, arithmetic: "chwr - chws = 12.04 - 6.8 = 5.24" } },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    expect(await screen.findByText("Pick a piece of equipment")).toBeInTheDocument();
    const g = await glyph("CH-2");
    await userEvent.click(g);
    expect(g).toHaveAttribute("aria-pressed", "true");

    const detail = document.querySelector('[data-detail="e2"]') as HTMLElement;
    expect(detail).not.toBeNull();
    expect(within(detail).getByRole("heading", { name: "CH-2" })).toBeInTheDocument();

    const chws = detail.querySelector('[data-slot="chws"]') as HTMLElement;
    expect(chws).toHaveAttribute("data-readiness", "reporting");
    expect(chws).toHaveTextContent("GW-1 / CHWS");
    expect(chws).toHaveTextContent("6.80 degC");

    const chwr = detail.querySelector('[data-slot="chwr"]') as HTMLElement;
    expect(chwr).toHaveAttribute("data-readiness", "unbound");
    expect(chwr).toHaveTextContent("not bound");
    expect(chwr).toHaveTextContent("not created");
    expect(chwr).toHaveTextContent(/is not bound to a point/);

    // Its metric is shown with the arithmetic that produced it — this one is
    // contrived (an unbound input with a value) and must NOT be a verdict.
    const dt = detail.querySelector('[data-metric="chw_delta_t"]') as HTMLElement;
    expect(dt).toHaveAttribute("data-metric-kind", "unknown");

    // A second press elsewhere moves the detail.
    await userEvent.click(await glyph("CH-1"));
    expect(document.querySelector('[data-detail="e1"]')).not.toBeNull();
    expect(document.querySelector('[data-detail="e2"]')).toBeNull();
  });

  it("shows a value with its working when every input reports", async () => {
    serve(
      plant([
        chiller({
          equipment_id: "e1",
          tag: "CH-1",
          metrics: { chw_delta_t: { status: "ok", value: 5.24, unit: "K", metric: "chw_delta_t", version: 1, arithmetic: "chwr - chws = 12.04 - 6.8 = 5.24" } },
        }),
      ]),
    );
    renderWithProviders(<Plant />);

    const g = await glyph("CH-1");
    expect(g.querySelector('[data-metric="chw_delta_t"]')!.textContent).toContain("5.2 K");
    await userEvent.click(g);
    const row = document.querySelector('[data-detail="e1"] [data-metric="chw_delta_t"]') as HTMLElement;
    expect(row).toHaveTextContent("5.2 K");
    expect(row).toHaveTextContent("chwr - chws = 12.04 - 6.8 = 5.24");
  });

  it("selects from the keyboard too", async () => {
    serve(plant([chiller({ equipment_id: "e1", tag: "CH-1" })]));
    renderWithProviders(<Plant />);

    const g = await glyph("CH-1");
    g.focus();
    await userEvent.keyboard("{Enter}");
    expect(document.querySelector('[data-detail="e1"]')).not.toBeNull();
  });
});

describe("the gates", () => {
  it("makes no request at all without bi.read", async () => {
    perms.granted = new Set(["bi.manage", "sites.read"]);
    renderWithProviders(<Plant />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("bi.read");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("makes no request without the analytics module", async () => {
    perms.modules = new Set();
    renderWithProviders(<Plant />);

    expect(await screen.findByText(/Needs/)).toHaveTextContent("analytics");
    await waitFor(() => expect(stub.calls).toHaveLength(0));
  });

  it("gives a reader Edit plant, and no import", async () => {
    renderWithProviders(<Plant />);

    expect(await screen.findByRole("link", { name: /Edit plant/ })).toHaveAttribute("href", infraDesignerHref("site-1"));
    await screen.findByRole("link", { name: /Describe it in Setup/ });
    expect(screen.queryByRole("link", { name: /Import I\/O schedule/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /import an I\/O schedule/ })).not.toBeInTheDocument();
  });

  it("gives bi.manage the import, landing in the designer's import for this building", async () => {
    perms.granted = new Set(["bi.read", "bi.manage"]);
    renderWithProviders(<Plant />);

    const imp = await screen.findByRole("link", { name: /Import I\/O schedule/ });
    expect(imp).toHaveAttribute("href", infraImportHref("site-1"));
    expect(imp.getAttribute("href")).toBe("/bi/setup/equipment?site=site-1&import=1");
  });

  it("scopes the gate strip to this building", async () => {
    renderWithProviders(<Plant />);

    await waitFor(() => expect(stub.matching("GET /bi/points/ghosts")).toHaveLength(1));
    expect(stub.matching("GET /bi/points/ghosts")[0]!.search.get("site_id")).toBe("site-1");
  });
});

describe("without a building", () => {
  it("lists the buildings to pick from, each opening its own plant", async () => {
    nav.params = new URLSearchParams();
    stub.set({
      "GET /bi/rating/sites": {
        items: [{ site_id: "site-9", site_name: "Nashik Depot", is_active: true }],
      },
    });
    renderWithProviders(<Plant />);

    expect(await screen.findByRole("link", { name: "Nashik Depot" })).toHaveAttribute("href", "/bi/plant?site=site-9");
    expect(stub.matching("GET /bi/sites/*")).toHaveLength(0);
  });
});
