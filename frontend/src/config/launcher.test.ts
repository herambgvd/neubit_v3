/**
 * A TILE MUST NOT OFFER A SURFACE THAT HAS NOTHING BEHIND IT.
 *
 * `perm` and `module` answer "is this caller allowed in". Neither answers "is
 * there anything on the other side" — and for DashForge there often is not:
 * it is an optional, separately-deployed peer, core's embed registry works
 * without it, and `dashforge.read` + `analytics` both pass on a deployment that
 * has no DashForge at all. So both Dashboards viewer tiles were always offered
 * and the click came back a 503 from `POST /dashforge/dashboards/{id}/session`.
 *
 * `gates.test.ts` covers the perm/module half. This covers the third question.
 */
import { describe, expect, it } from "vitest";

import { LAUNCHER_MODES, gateTile, type LauncherTile } from "./launcher";

const allow = { can: () => true, hasModule: () => true };

/** Every tile in the IA that names an optional peer. */
const integrationTiles: LauncherTile[] = LAUNCHER_MODES.flatMap((m) =>
  m.groups.flatMap((g) => g.tiles.filter((t) => t.integration)),
);

describe("optional-peer gating", () => {
  it("is declared on both DashForge VIEWER tiles", () => {
    // Not the Configurations → Dashboards tile: that screen registers, renames
    // and removes rows in core's own table and works with no peer deployed.
    expect(integrationTiles.map((t) => t.href).sort()).toEqual([
      "/bi/dashboards",
      "/surveillance/dashboards",
    ]);
    expect(integrationTiles.every((t) => t.integration === "dashforge")).toBe(true);
  });

  it("dims a tile whose peer is not deployed, even for an allowed caller", () => {
    for (const tile of integrationTiles) {
      const gated = gateTile(tile, { ...allow, hasIntegration: () => false });
      expect(gated.href, `${tile.label} (${tile.href})`).toBeUndefined();
      expect(gated.soon).toBe(true);
    }
  });

  it("leaves it alone when the peer IS deployed", () => {
    for (const tile of integrationTiles) {
      expect(gateTile(tile, { ...allow, hasIntegration: () => true })).toEqual(tile);
    }
  });

  it("assumes present when the caller cannot say, so a working surface is never hidden", () => {
    for (const tile of integrationTiles) {
      expect(gateTile(tile, allow)).toEqual(tile);
    }
  });

  it("still dims on permission alone, whatever the peer is doing", () => {
    const tile = integrationTiles[0]!;
    const gated = gateTile(tile, { can: () => false, hasModule: () => true, hasIntegration: () => true });
    expect(gated.soon).toBe(true);
  });
});

/**
 * TWO SCOPES, NOT TEN DOORS.
 *
 * The mode carried TEN flat tiles. Two of them — Duplicate Points and Stranded
 * Roles — were the WORKLISTS OF SHUT GATES 1 and 4 sitting as peers of the
 * estate view. A worklist is what you reach by pressing the gate that is shut,
 * so they are gone from here and nothing was deleted: both routes still resolve
 * and the gate strip names them.
 *
 * THE THREE DOMAIN TILES WENT WITH THEM ONCE, AND THAT WAS WRONG. The argument
 * was that Building's Domains lane already reaches the same console, so a tile
 * for each was a second door into one room. They are not one room — they are two
 * SCOPES of one data set:
 *
 *   /bi/energy              the whole estate's energy, every building combined
 *                           plus the points no building owns
 *   /bi/energy?site=<uuid>  that one building's energy
 *
 * 366 energy points, 95 HVAC points and 10 water points belong to no site at
 * all, so the unscoped route is the ONLY way to reach them. Removing the tiles
 * made them unreachable in the product. This is the guard against doing it
 * again — in either direction.
 */
const biTiles = LAUNCHER_MODES.find((m) => m.id === "int")!.groups.flatMap((g) => g.tiles);

describe("Building Intelligence's doors", () => {
  it("has exactly one door into the pipeline, and it is L1", () => {
    const layer = biTiles.filter((t) => t.href === "/bi/portfolio");
    expect(layer).toHaveLength(1);
    expect(layer[0]!.label).toBe("Building");
  });

  it("offers no tile for a gate's worklist", () => {
    const hrefs = biTiles.map((t) => t.href);
    for (const h of ["/bi/duplicates", "/bi/succession", "/bi/placement", "/bi/metrics"]) {
      expect(hrefs).not.toContain(h);
    }
    expect(hrefs.filter((h) => h?.startsWith("/bi/setup/"))).toEqual([]);
  });

  it("has one door into Setup, gated like every BI tile", () => {
    const setup = biTiles.filter((t) => t.href === "/bi/setup");
    expect(setup).toHaveLength(1);
    expect(setup[0]!.label).toBe("Setup");
    expect(setup[0]!.perm).toBe("bi.read");
    expect(setup[0]!.module).toBe("analytics");
  });

  it("opens each domain across the whole estate, unscoped", () => {
    // UNSCOPED is the whole assertion. A tile carrying `?site=` would be the
    // building-first path wearing the estate-first tile's label, and the points
    // no site owns would have no door at all.
    for (const [href, label] of [
      ["/bi/energy", "Energy & Metering"],
      ["/bi/hvac", "HVAC & Assets"],
      ["/bi/water", "Water"],
    ] as const) {
      const tile = biTiles.find((t) => t.href === href);
      expect(tile, `${href} is the estate-wide door into that domain`).toBeDefined();
      expect(tile!.label).toBe(label);
      expect(tile!.href).not.toMatch(/\?/);
      expect(tile!.soon).toBeUndefined();
    }
  });

  it("gates every domain tile exactly as it gates the pipeline's front door", () => {
    // One key, one module, across both scopes: a caller who can open Building
    // can open a domain, and a caller who cannot sees SOON on both rather than
    // a 403 on one.
    const front = biTiles.find((t) => t.href === "/bi/portfolio")!;
    for (const href of ["/bi/energy", "/bi/hvac", "/bi/water"]) {
      const tile = biTiles.find((t) => t.href === href)!;
      expect(tile.perm, href).toBe(front.perm);
      expect(tile.module, href).toBe(front.module);
    }
  });

  it("keeps the surfaces that are not layers or worklists", () => {
    // Ratings, Insights, Metric Roles and Dashboards each answer a question no
    // layer of the pipeline does. Demoting one would be hiding a surface, not
    // simplifying an information architecture.
    const hrefs = biTiles.map((t) => t.href);
    for (const kept of ["/bi/ratings", "/bi/insights", "/bi/setup", "/bi/dashboards"]) {
      expect(hrefs).toContain(kept);
    }
  });
});

describe("Configurations", () => {
  it("carries nothing BI-shaped — BI configuration is BI → Setup", () => {
    // neubit_v3 sells as a VMS first: a VMS-only customer must never meet a
    // chiller, a unit or a metric role on the Configurations screen.
    const conf = LAUNCHER_MODES.find((m) => m.id === "conf")!.groups.flatMap((g) => g.tiles);
    expect(
      conf.filter((t) => t.href?.startsWith("/bi") || /equipment|metric|unit|building fact/i.test(t.label)),
    ).toEqual([]);
  });
});
