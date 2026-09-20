/**
 * The plate facts, on the way to core. What must not go wrong:
 *
 *   • a design PUT REPLACES the set, so answering one fact must send every
 *     other recorded fact back unchanged — including one this screen never
 *     shows;
 *   • a band is two facts and one answer, in the order the server names them;
 *   • a number that core would refuse (blank, zero, negative, words, a band the
 *     wrong way round) is refused here, so the only press offered is one that
 *     can succeed;
 *   • a refused metric is named in words, and a key nobody has words for prints
 *     as itself rather than as an invented phrase.
 */
import { describe, expect, it } from "vitest";

import { blocksText, designWith, readBand, readNumber, stepsOf, type NameplateQuestion } from "./nameplate";

const band: NameplateQuestion = {
  kind: "band",
  facts: ["design_dt_min", "design_dt_max"],
  unit: "K",
  observed: { low: 4.8, high: 6.9, median: 5.6, hours: 512, days: 30, wide: false, spread: [4.2, 7.4] },
  blocks: ["chw_delta_t_in_band"],
};
const capacity: NameplateQuestion = {
  kind: "capacity",
  facts: ["tr"],
  unit: "TR",
  label: "Rated capacity",
  observed: null,
  blocks: ["chiller_kw_per_tr"],
};

describe("designWith", () => {
  it("sends every other recorded fact back unchanged", () => {
    // `make` is not asked anywhere on this screen. Answering the capacity must
    // not clear it.
    expect(designWith({ make: "York", design_dt_min: 5, design_dt_max: 7 }, capacity, 350)).toEqual({
      make: "York",
      design_dt_min: 5,
      design_dt_max: 7,
      tr: 350,
    });
  });

  it("writes both ends of a band, in the order the server named them", () => {
    expect(designWith({ tr: 350 }, band, { low: 4.8, high: 6.9 })).toEqual({
      tr: 350,
      design_dt_min: 4.8,
      design_dt_max: 6.9,
    });
  });

  it("overwrites half a band that was already on file", () => {
    expect(designWith({ design_dt_min: 9 }, band, { low: 5, high: 7 })).toEqual({
      design_dt_min: 5,
      design_dt_max: 7,
    });
  });
});

describe("what an operator may type", () => {
  it.each(["", "  ", "0", "-3", "abc", "5 tons"])("refuses %o", (raw) => {
    expect(readNumber(raw)).toBeNull();
  });

  it("takes a plain number, spaces and all", () => {
    expect(readNumber(" 350 ")).toBe(350);
    expect(readNumber("4.8")).toBe(4.8);
  });

  it("refuses a band that is missing an end, or is the wrong way round", () => {
    expect(readBand("5", "")).toEqual({ error: "Both ends need a number." });
    expect(readBand("7", "5")).toEqual({ error: "The second number has to be the bigger one." });
    expect(readBand("5", "5")).toEqual({ error: "The second number has to be the bigger one." });
  });

  it("takes a band in order", () => {
    expect(readBand("4.8", "6.9")).toEqual({ low: 4.8, high: 6.9 });
  });
});

describe("what a skip costs", () => {
  it("says it in words an operator uses", () => {
    expect(blocksText(["chiller_kw_per_tr"])).toBe("how much power it draws per ton of cooling");
    expect(blocksText(["chiller_kw_per_tr", "chw_delta_t_in_band"])).toBe(
      "how much power it draws per ton of cooling and whether it is cooling the water as much as it should",
    );
  });

  it("prints a metric nobody has words for as itself", () => {
    expect(blocksText(["some_new_metric"])).toBe("some_new_metric");
    expect(blocksText([])).toBeNull();
  });
});

describe("stepsOf", () => {
  it("flattens every machine's questions into one queue", () => {
    const steps = stepsOf({
      site_id: "s1",
      days: 30,
      asks: [
        { equipment_id: "e1", tag: "CH-01", name: null, equipment_class: "chiller", questions: [band, capacity] },
        { equipment_id: "e2", tag: "CH-02", name: null, equipment_class: "chiller", questions: [capacity] },
      ],
      totals: { machines: 2, of_interest: 2, asked: 2, answered: 0 },
    });
    expect(steps.map((s) => [s.tag, s.question.kind])).toEqual([
      ["CH-01", "band"],
      ["CH-01", "capacity"],
      ["CH-02", "capacity"],
    ]);
  });

  it("is empty when nothing is missing", () => {
    expect(stepsOf(undefined)).toEqual([]);
  });
});
