/**
 * The design PUT replaces the whole set. The screen's test proves an edit sends
 * the other facts back; this proves the harder half — the tree refetches under
 * an open form, so a fact someone else changed meanwhile must be sent as the
 * server holds it NOW, not as it was when the form opened.
 */
import { describe, expect, it } from "vitest";

import type { InfraDesignFactDef } from "@/lib/types";

import { buildDesign, draftFrom } from "./vocabulary";

const FACTS: InfraDesignFactDef[] = [
  { key: "make", type: "text", unit: null, label: "Make" },
  { key: "tr", type: "number", unit: "TR", label: "Rated capacity" },
  { key: "design_dt_min", type: "number", unit: "K", label: "ΔT min" },
  { key: "design_dt_max", type: "number", unit: "K", label: "ΔT max" },
];

describe("buildDesign", () => {
  it("sends an untouched fact as it is recorded now, not as the form first read it", () => {
    const opened = { make: "York", tr: 350 };
    const initial = draftFrom(opened, FACTS);
    // Someone else recorded the band while this form was open.
    const now = { make: "York", tr: 350, design_dt_min: 5, design_dt_max: 7 };

    const built = buildDesign(now, initial, { ...initial, make: "Carrier" }, FACTS);

    expect(built.design).toEqual({ make: "Carrier", tr: 350, design_dt_min: 5, design_dt_max: 7 });
    expect(built.cleared).toEqual([]);
  });

  it("refuses half a ΔT band before anything is sent", () => {
    const initial = draftFrom({}, FACTS);
    const built = buildDesign({}, initial, { ...initial, design_dt_min: "5" }, FACTS);

    expect(built.errors.design_dt_min).toMatch(/both bounds/);
  });
});
