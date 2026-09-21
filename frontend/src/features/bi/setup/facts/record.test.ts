/**
 * The building's record, on the way to core. Two of the three writes REPLACE a
 * whole set, so what must not go wrong is what a press SENDS:
 *
 *   • recording the area must send the tariff, the currency AND the occupancy
 *     back — occupancy is asked for nowhere on this screen and would otherwise
 *     be cleared by editing something else;
 *   • adding a carbon figure must send every figure already on file back, each
 *     with its own citation;
 *   • a figure a person types that core would refuse is refused here;
 *   • every missing fact says which figure stays off, in words, and a fact
 *     nothing reads says that instead of claiming work.
 */
import { describe, expect, it } from "vitest";

import {
  benchmarkLine,
  blockedText,
  factorsPut,
  factsPut,
  readPercent,
  readPositive,
  readsText,
  zoneText,
  type Fact,
  type FactsRecord,
} from "./record";

const area: Fact = {
  key: "area", label: "Floor area", value: 40000, unit: "m²", source: null,
  recorded_at: "2026-08-31T19:26:00Z", reads: ["bee_star_band", "carbon_intensity", "intensity_score"],
  why: "Every per-square-metre figure divides by it.",
};
const tariff: Fact = {
  key: "tariff", label: "Electricity rate", value: 10, unit: "INR / kWh", source: null,
  recorded_at: "2026-08-31T19:26:00Z", reads: [], why: "What a unit costs.",
};
const factor: Fact = {
  key: "emission_factor", label: "Carbon per unit of grid electricity", value: 0.716,
  unit: "kg CO₂ / kWh", source: "CEA CO2 Baseline Database v20.0", recorded_at: null,
  reads: ["carbon_intensity"], why: "Published every year.",
  factors: [
    { position: 0, kg_co2_per_kwh: 0.716, source: "CEA v20.0", effective_from: "2025-04-01T00:00:00Z" },
    { position: 1, kg_co2_per_kwh: 0.727, source: "CEA v19.0", effective_from: "2024-04-01" },
  ],
};
const benchmark: Fact = {
  key: "benchmark", label: "Which yardstick to grade against",
  value: "BEE Star Rating of Commercial Buildings — Office Buildings", unit: null,
  source: "Bureau of Energy Efficiency, Section 6", recorded_at: null, reads: ["bee_star_band"],
  why: "A star rating is a published scheme.", standard: "bee_star_office", version: "jan-2022",
  climate_zone: "warm_humid", ac_category: "gt50pct_ac", ac_share_percent: null,
  size_category: "large", missing: "ac_share_percent", on_file: false,
  zone_options: ["composite", "hot_dry", "warm_humid"],
};

const record = (over: Partial<FactsRecord> = {}): FactsRecord => ({
  site_id: "s1",
  site_name: "Aeon Tower",
  known: true,
  carried: { occupancy: 1200, tariff_currency: "INR" },
  on_file: [area, tariff],
  missing: [factor, benchmark],
  totals: { on_file: 2, missing: 2 },
  ...over,
});

describe("factsPut", () => {
  it("sends the occupancy this screen never shows back, so an area edit cannot clear it", () => {
    expect(factsPut(record(), { area: 42000 })).toEqual({
      gross_floor_area_sqm: 42000,
      energy_tariff_per_kwh: 10,
      tariff_currency: "INR",
      occupancy: 1200,
    });
  });

  it("keeps a recorded area when the tariff is the thing being changed", () => {
    expect(factsPut(record(), { tariff: 11.5, currency: "INR" })).toEqual({
      gross_floor_area_sqm: 40000,
      energy_tariff_per_kwh: 11.5,
      tariff_currency: "INR",
      occupancy: 1200,
    });
  });

  it("sends null for a fact that was never recorded rather than inventing a zero", () => {
    const rec = record({ on_file: [tariff], missing: [{ ...area, value: null, recorded_at: null }, factor, benchmark] });
    expect(factsPut(rec, { tariff: 12 }).gross_floor_area_sqm).toBeNull();
  });
});

describe("factorsPut", () => {
  it("sends every figure already on file back, with its own citation, plus the new one", () => {
    const added = { kg_co2_per_kwh: 0.708, source: "CEA v21.0", effective_from: "2026-04-01" };
    expect(factorsPut(factor, added)).toEqual([
      { kg_co2_per_kwh: 0.716, source: "CEA v20.0", effective_from: "2025-04-01" },
      { kg_co2_per_kwh: 0.727, source: "CEA v19.0", effective_from: "2024-04-01" },
      added,
    ]);
  });

  it("is just the new one when nothing is on file", () => {
    const added = { kg_co2_per_kwh: 0.716, source: "CEA v20.0", effective_from: "2025-04-01" };
    expect(factorsPut(undefined, added)).toEqual([added]);
    expect(factorsPut({ ...factor, factors: [] }, added)).toEqual([added]);
  });

  it("drops a half-recorded figure rather than sending one core would refuse", () => {
    const broken = { ...factor, factors: [{ position: 0, kg_co2_per_kwh: 0.7, source: null, effective_from: null }] };
    const added = { kg_co2_per_kwh: 0.716, source: "CEA v20.0", effective_from: "2025-04-01" };
    expect(factorsPut(broken, added)).toEqual([added]);
  });
});

describe("what an operator may type", () => {
  it.each(["", "   ", "0", "-5", "abc"])("refuses %o as a positive figure", (raw) => {
    expect(readPositive(raw)).toBeNull();
  });

  it("takes a plain figure", () => {
    expect(readPositive(" 40000 ")).toBe(40000);
    expect(readPositive("0.716")).toBe(0.716);
  });

  it("takes a share between 0 and 100 and nothing else", () => {
    expect(readPercent("78")).toBe(78);
    expect(readPercent("0")).toBe(0);
    expect(readPercent("100")).toBe(100);
    expect(readPercent("101")).toBeNull();
    expect(readPercent("-1")).toBeNull();
    expect(readPercent("")).toBeNull();
  });
});

describe("the words", () => {
  it("says which figure a missing fact holds up", () => {
    expect(blockedText(factor)).toBe(
      "Until this is recorded, the building's carbon per square metre stays off. Nothing else is affected.",
    );
    expect(blockedText(benchmark)).toMatch(/the star rating stays off/);
  });

  it("says plainly when nothing reads a fact yet", () => {
    expect(blockedText(tariff)).toBe("Nothing reads this yet.");
    expect(readsText([])).toBeNull();
  });

  it("names a figure nobody has words for by its key", () => {
    expect(readsText(["some_new_metric"])).toBe("some_new_metric");
  });

  it("reads a recorded benchmark as one line", () => {
    expect(benchmarkLine({ ...benchmark, ac_share_percent: 78 })).toBe(
      "Warm and humid · 78% air-conditioned · bands of jan-2022",
    );
    // No share on file: the older version's category is what is known.
    expect(benchmarkLine(benchmark)).toBe("Warm and humid · mostly air-conditioned · bands of jan-2022");
  });

  it("prints a zone the seeded table publishes that nobody has words for as itself", () => {
    expect(zoneText("mountain_dry")).toBe("mountain_dry");
    expect(zoneText(null)).toBeNull();
  });
});
