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
