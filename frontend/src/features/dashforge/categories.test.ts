/**
 * The category set is DUPLICATED — once in `constants.ts` for the console's tabs
 * and icons, once in `backend/core/app/dashforge/categories.py` for the value the
 * API will accept. Both sides are closed sets, which is what makes the drift
 * dangerous rather than cosmetic:
 *
 *  • a slug here that the backend does not know is a category an operator can
 *    pick in the form and the API answers 422 for;
 *  • a slug there that is missing here is a bucket rows can be written into that
 *    no tab lists, so the dashboards in it are registered and reachable only by
 *    their direct link.
 *
 * So this reads the Python and compares. Same reasoning as `src/test/contract.
 * test.ts`: both files are in this repo, so a change on either side fails on the
 * commit that makes it, not on the next deploy.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseDictKeys } from "@/test/pydantic";

import { CATEGORIES, DEFAULT_CATEGORY, categoryLabel } from "./constants";

const PY = path.resolve(
  __dirname,
  "../../../..",
  "backend/core/app/dashforge/categories.py",
);

const backendSlugs = () => parseDictKeys(PY, "DASHBOARD_CATEGORIES");

describe("the category set", () => {
  it("holds exactly the slugs the API accepts", () => {
    expect(CATEGORIES.map((c) => c.slug)).toEqual(backendSlugs());
  });

  it("defaults to a category that has a tab", () => {
    // A default the console does not list would file every unclassified
    // dashboard where nobody can see it.
    expect(CATEGORIES.map((c) => c.slug)).toContain(DEFAULT_CATEGORY);
  });

  it("gives every category a label and an icon", () => {
    for (const c of CATEGORIES) {
      expect(c.label.trim()).not.toBe("");
      expect(c.icon).toMatch(/^heroicons/);
    }
  });

  it("shows an unknown slug as itself rather than dropping it", () => {
    // A row written under a category later retired must still render with SOME
    // name — blank would read as a dashboard belonging to nothing.
    expect(categoryLabel("cctv")).toBe("cctv");
    expect(categoryLabel("vms")).toBe("Surveillance");
  });
});
