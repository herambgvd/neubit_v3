/**
 * About the building — the record, and what each press sends.
 *
 *   • what is missing leads, naming the figure it holds up; what is on file sits
 *     below with its source and date;
 *   • recording the area sends the whole set back, occupancy included;
 *   • a carbon figure will not be sent without its source — a figure with no
 *     citation is a guess;
 *   • the AC share goes to the benchmark config, not to core's facts;
 *   • occupancy and a city are not asked for anywhere;
 *   • a viewer without sites.update sees the record and no control that writes.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { stubApi, type ApiStub } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import FactsRecord from "./FactsRecord";

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ can: () => true, hasModule: () => true }) }));

const RECORD = {
  site_id: "s1",
  site_name: "Aeon Tower",
  known: true,
  carried: { occupancy: 1200, tariff_currency: "INR" },
  on_file: [
    {
      key: "area", label: "Floor area", value: 40000, unit: "m²", source: null,
      recorded_at: "2026-08-31T19:26:00Z",
      reads: ["bee_star_band", "carbon_intensity", "intensity_score"],
      why: "Every per-square-metre figure divides by it.",
    },
    {
      key: "tariff", label: "Electricity rate", value: 10, unit: "INR / kWh", source: null,
      recorded_at: "2026-08-31T19:26:00Z", reads: [], why: "What a unit of electricity costs.",
    },
  ],
  missing: [
    {
      key: "emission_factor", label: "Carbon per unit of grid electricity", value: null,
      unit: "kg CO₂ / kWh", source: null, recorded_at: null, reads: ["carbon_intensity"],
      why: "Published every year for the national grid.", factors: [],
    },
    {
      key: "benchmark", label: "Which yardstick to grade against",
      value: "BEE Star Rating of Commercial Buildings — Office Buildings", unit: null,
      source: "Bureau of Energy Efficiency, Section 6", recorded_at: null,
      reads: ["bee_star_band"], why: "A star rating is a published scheme.",
      standard: "bee_star_office", version: "jan-2022", climate_zone: "warm_humid",
      ac_category: "gt50pct_ac", ac_share_percent: null, size_category: "large",
      missing: "ac_share_percent", on_file: false,
      zone_options: ["composite", "hot_dry", "warm_humid"],
    },
  ],
  totals: { on_file: 2, missing: 2 },
};

let stub: ApiStub;

beforeEach(() => {
  stub = stubApi({
    "GET /bi/sites/s1/facts": RECORD,
    "GET /sites/s1": { site_id: "s1", site_name: "Aeon Tower", is_active: true },
    "GET /sites/s1/tariff-slabs": { items: [], total: 0 },
    "GET /sites/s1/emission-factors": { items: [], total: 0 },
    "PUT /sites/s1/building-facts": { site_id: "s1" },
    "PUT /sites/s1/emission-factors": { items: [], total: 1 },
    "PUT /bi/rating/benchmark-config": { site_id: "s1" },
  });
});

const render = (mayWrite = true) => {
  renderWithProviders(<FactsRecord siteId="s1" mayWrite={mayWrite} />);
  return userEvent.setup();
};

/** The row or card a fact's own value sits in — "Change" is on every row. */
const rowOf = async (text: string | RegExp) => (await screen.findByText(text)).closest("div")!.parentElement!;

describe("the record", () => {
  it("leads with what is waiting, naming the figure it holds up", async () => {
    render();

    expect(await screen.findByRole("heading", { name: "Carbon per unit of grid electricity" })).toBeInTheDocument();
    expect(screen.getByText(/the building's carbon per square metre stays off/)).toBeInTheDocument();
    expect(screen.getByText(/the star rating stays off/)).toBeInTheDocument();
  });

  it("shows what is on file with its date, and says when nothing reads it yet", async () => {
    render();

    const areaRow = (await screen.findByText("40,000 m²")).parentElement!;
    // The date is rendered in the reader's own timezone, so the year is what is
    // asserted, not a day that shifts either side of midnight UTC.
    expect(areaRow).toHaveTextContent(/Recorded \d{1,2} \w+ 2026/);
    expect(areaRow).toHaveTextContent("the star rating");
    // The tariff is recorded and nothing computes with it — said, not implied.
    expect(screen.getByText("10 INR / kWh").parentElement).toHaveTextContent("nothing reads it yet");
  });

  it("asks for no occupancy and no city anywhere", async () => {
    render();
    await screen.findByText("40,000 m²");
    expect(screen.queryByText(/occupancy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bcity\b/i)).not.toBeInTheDocument();
  });
});

describe("recording the area", () => {
  it("sends the whole set back, occupancy included", async () => {
    const user = render();
    await user.click(within(await rowOf("40,000 m²")).getByRole("button", { name: "Change" }));

    const input = screen.getByLabelText("Floor area");
    await user.clear(input);
    await user.type(input, "42000");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/building-facts")).toEqual({
        gross_floor_area_sqm: 42000,
        energy_tariff_per_kwh: 10,
        tariff_currency: "INR",
        occupancy: 1200,
      }),
    );
  });

  it("refuses a figure core would refuse", async () => {
    const user = render();
    await user.click(within(await rowOf("40,000 m²")).getByRole("button", { name: "Change" }));
    const input = screen.getByLabelText("Floor area");
    await user.clear(input);
    await user.type(input, "-5");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("An area is a number of square metres.")).toBeInTheDocument();
    expect(stub.matching("PUT /sites/s1/building-facts")).toHaveLength(0);
  });
});

describe("recording the carbon figure", () => {
  it("will not send it without a source", async () => {
    const user = render();
    const card = (await screen.findByRole("heading", { name: "Carbon per unit of grid electricity" })).closest("div")!
      .parentElement!.parentElement!;
    await user.click(within(card).getByRole("button", { name: "Record it" }));

    await user.type(screen.getByLabelText("Carbon per unit"), "0.716");
    await user.type(screen.getByLabelText("Applies from"), "2025-04-01");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText(/a figure with no source is a guess/)).toBeInTheDocument();
    expect(stub.matching("PUT /sites/s1/emission-factors")).toHaveLength(0);

    await user.type(screen.getByLabelText("Where it came from"), "CEA CO2 Baseline Database v20.0");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(stub.body("PUT /sites/s1/emission-factors")).toEqual({
        factors: [
          { kg_co2_per_kwh: 0.716, source: "CEA CO2 Baseline Database v20.0", effective_from: "2025-04-01" },
        ],
      }),
    );
  });
});

describe("the star rating's inputs", () => {
  it("send the share to the benchmark config, not to core's facts", async () => {
    const user = render();
    const card = (await screen.findByRole("heading", { name: "Which yardstick to grade against" })).closest("div")!
      .parentElement!.parentElement!;
    await user.click(within(card).getByRole("button", { name: "Record it" }));

    await user.type(screen.getByLabelText("Air-conditioned share"), "78");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(stub.body("PUT /bi/rating/benchmark-config")).toEqual({ site_id: "s1", ac_share_percent: 78 }),
    );
    expect(stub.matching("PUT /sites/s1/building-facts")).toHaveLength(0);
  });

  it("refuses a share outside 0–100", async () => {
    const user = render();
    const card = (await screen.findByRole("heading", { name: "Which yardstick to grade against" })).closest("div")!
      .parentElement!.parentElement!;
    await user.click(within(card).getByRole("button", { name: "Record it" }));

    await user.type(screen.getByLabelText("Air-conditioned share"), "140");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByText("A share is between 0 and 100.")).toBeInTheDocument();
    expect(stub.matching("PUT /bi/rating/benchmark-config")).toHaveLength(0);
  });
});

describe("a viewer without sites.update", () => {
  it("sees the record and no control that writes", async () => {
    render(false);

    expect(await screen.findByText("40,000 m²")).toBeInTheDocument();
    expect(screen.getByText(/the star rating stays off/)).toBeInTheDocument();
    for (const name of ["Change", "Record it", "Save"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});
