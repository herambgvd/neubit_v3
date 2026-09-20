/**
 * The words the screen uses, and the one piece of arithmetic behind its bulk
 * press. What must not go wrong:
 *
 *   • a role and a metric are said in the machine room's words, and anything
 *     nobody has words for prints as itself rather than as an invented phrase;
 *   • a question the platform is unsure about carries a caution — a dead
 *     generation beside an answered one, a reading carrying nothing, several
 *     readings claiming one meaning;
 *   • "yes to everything on this device" NEVER includes a cautioned question,
 *     and it presses once per role, never once per reading.
 */
import { describe, expect, it } from "vitest";

import { bulkOf, cautionOf, fmtValue, neededByText, roleLong, roleShort, type RoleAsk } from "./asks";

const ask = (over: Partial<RoleAsk> = {}): RoleAsk => ({
  point_id: over.point_id ?? "p1",
  point_tag: "IWT",
  answered: false,
  role: "inlet_water_temp",
  role_label: "Entering water temperature",
  basis: "the tag is `IWT` — entering water temperature by this estate's convention",
  needed_by: ["chiller_delta_t"],
  value: 28.4,
  at: "2026-09-20T10:00:00Z",
  unit: "degC",
  reporting: true,
  same_role_answered: [],
  same_role_others: [],
  ...over,
});

describe("the words", () => {
  it("says a role the way the machine room says it", () => {
    expect(roleShort(ask())).toBe("the water going in");
    expect(roleLong(ask({ role: "energy_register" }))).toMatch(/since the day it was installed/);
  });

  it("falls back to the server's own label for a role nobody has words for", () => {
    const a = ask({ role: "pressure_head", role_label: "Pressure head" });
    expect(roleShort(a)).toBe("pressure head");
    expect(roleLong(a)).toBeNull();
  });

  it("names the metrics that read it, and a new metric by its key", () => {
    expect(neededByText(["chiller_delta_t"])).toBe("how hard this chiller is working");
    expect(neededByText(["carbon_intensity", "intensity_score"])).toBe(
      "the building's carbon per square metre and the building's energy per square metre",
    );
    expect(neededByText(["something_seeded_later"])).toBe("something_seeded_later");
    expect(neededByText([])).toBeNull();
  });

  it("collapses two metrics that read it for the same reason into one phrase", () => {
    // `chiller_delta_t` and `chw_delta_t` are the same question to an operator.
    expect(neededByText(["chiller_delta_t", "chw_delta_t"])).toBe("how hard this chiller is working");
  });

  it("prints the reading, or says there is none — never a zero for a missing value", () => {
    expect(fmtValue(ask({ value: 28.42 }))).toBe("28.4 degC");
    expect(fmtValue(ask({ value: 5035.29, unit: "kWh" }))).toBe("5,035 kWh");
    expect(fmtValue(ask({ value: null }))).toBe("no reading");
    expect(fmtValue(ask({ value: 0 }))).toBe("0 degC");
  });
});

describe("the cautions", () => {
  it("warns when the device already answers this on another reading", () => {
    // The live rename: `IWT` is the dead generation of `4FKC2_IWT`.
    expect(cautionOf(ask({ same_role_answered: ["4FKC2_IWT"] }))).toMatch(/count one sensor twice/);
  });

  it("warns when nothing has arrived from the reading", () => {
    expect(cautionOf(ask({ reporting: false }))).toMatch(/nothing has arrived/);
  });

  it("warns when several readings claim the same meaning", () => {
    // 2F York Chiller01, live: three kWh registers, two of them old generations.
    const c = cautionOf(ask({ role: "energy_register", same_role_others: ["2FYC1_EM_kWh", "2FChiller1EM_kWh"] }));
    expect(c).toMatch(/only one of them is it/);
  });

  it("says nothing about a plain question", () => {
    expect(cautionOf(ask())).toBeNull();
  });
});

describe("bulkOf", () => {
  const device = (asks: RoleAsk[]) => ({
    device_id: "d1",
    device_tag: "4F Khem Chiller02",
    site_id: "s1",
    site_name: "Aeon Tower",
    asks,
    answered: [],
  });

  it("presses once per role, with the ids of the questions it covers", () => {
    expect(
      bulkOf(
        device([
          ask({ point_id: "p1", point_tag: "IWT" }),
          ask({ point_id: "p2", point_tag: "OWT", role: "outlet_water_temp" }),
          ask({ point_id: "p3", point_tag: "4FKC2_kWh", role: "energy_register", unit: "kWh" }),
        ]),
      ),
    ).toEqual([
      { role: "inlet_water_temp", point_ids: ["p1"] },
      { role: "outlet_water_temp", point_ids: ["p2"] },
      { role: "energy_register", point_ids: ["p3"] },
    ]);
  });

  it("leaves out every cautioned question — a bulk press is not how a doubtful answer gets stored", () => {
    expect(
      bulkOf(
        device([
          ask({ point_id: "p1" }),
          ask({ point_id: "p2", reporting: false }),
          ask({ point_id: "p3", same_role_answered: ["4FKC2_IWT"] }),
          ask({ point_id: "p4", role: "energy_register", same_role_others: ["x"] }),
        ]),
      ),
    ).toEqual([{ role: "inlet_water_temp", point_ids: ["p1"] }]);
  });

  it("is empty when every question wants a second look", () => {
    expect(bulkOf(device([ask({ reporting: false })]))).toEqual([]);
  });
});
