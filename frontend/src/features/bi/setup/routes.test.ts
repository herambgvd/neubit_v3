/**
 * Where Setup lives, and how every older door into it still arrives.
 *
 *   • `infraDesignerHref` — the one deep link into the equipment designer —
 *     points into Setup, and the name Sites used to export still resolves to it;
 *   • the four worklist routes that predate Setup REDIRECT into it, carrying
 *     their query (a bookmarked `?category=hvac` must still scope the list).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { infraDesignerHref as fromSites } from "@/features/core/sites/links";

import { carryQuery, infraDesignerHref, infraImportHref, taskOfPath } from "./routes";

const nav = vi.hoisted(() => ({ to: null as string | null }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    nav.to = to;
    throw new Error("NEXT_REDIRECT");
  },
}));

beforeEach(() => {
  nav.to = null;
});

describe("infraDesignerHref", () => {
  it("opens BI → Setup → Equipment on the building and the equipment", () => {
    expect(infraDesignerHref("s2", "e9")).toBe("/bi/setup/equipment?site=s2&equipment=e9");
    expect(infraDesignerHref("s2")).toBe("/bi/setup/equipment?site=s2");
  });

  it("has a twin that lands in the designer's I/O schedule import", () => {
    expect(infraImportHref("s2")).toBe("/bi/setup/equipment?site=s2&import=1");
  });

  it("is what a caller importing it from Sites gets", () => {
    expect(fromSites("s2", "e9")).toBe("/bi/setup/equipment?site=s2&equipment=e9");
  });
});

describe("carryQuery", () => {
  it("keeps every value, repeated keys included", () => {
    expect(carryQuery("/x", { category: "hvac", point_id: ["a", "b"], gone: undefined })).toBe(
      "/x?category=hvac&point_id=a&point_id=b",
    );
    expect(carryQuery("/x", undefined)).toBe("/x");
  });
});

describe("the stranded-role worklist", () => {
  it("belongs to Metric roles", () => {
    expect(taskOfPath("/bi/setup/stranded")).toBe("roles");
    expect(taskOfPath("/bi/setup")).toBeNull();
  });
});

async function landsOn(mod: Promise<{ default: (p: any) => Promise<unknown> }>, query: Record<string, string> = {}) {
  const page = (await mod).default;
  await expect(page({ searchParams: Promise.resolve(query) })).rejects.toThrow("NEXT_REDIRECT");
  return nav.to;
}

describe("the routes Setup replaced", () => {
  it("/bi/duplicates lands on the checklist — the gate it opened is gone", async () => {
    // The gateway keeps its point ids across a rebuild, so nothing duplicates
    // and there is no worklist to land on. The URL still resolves.
    expect(await landsOn(import("@/app/(app)/bi/duplicates/page"))).toBe("/bi/setup");
  });

  it("/bi/setup/units lands there too — the gateway records the unit now", async () => {
    expect(await landsOn(import("@/app/(app)/bi/setup/units/page"))).toBe("/bi/setup");
  });

  it("/bi/placement lands on Setup → Buildings & devices, still scoped", async () => {
    expect(await landsOn(import("@/app/(app)/bi/placement/page"), { category: "hvac" })).toBe(
      "/bi/setup/placement?category=hvac",
    );
  });

  it("/bi/succession lands on Metric roles, where stranded answers are settled now", async () => {
    expect(await landsOn(import("@/app/(app)/bi/succession/page"))).toBe("/bi/setup/roles");
  });

  it("the old stranded worklist lands there too, rather than 404ing a bookmark", async () => {
    expect(await landsOn(import("@/app/(app)/bi/setup/stranded/page"))).toBe("/bi/setup/roles");
  });

  it("/bi/metrics lands on Setup → Metric roles", async () => {
    expect(await landsOn(import("@/app/(app)/bi/metrics/page"))).toBe("/bi/setup/roles");
  });
});
