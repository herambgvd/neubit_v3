/**
 * A NAV GATE MUST NAME A PERMISSION SOMEBODY CAN HOLD.
 *
 * `can(perm)` is a membership test against the role's permission list, and a
 * role can only hold what core's catalog carries — the role editor is built from
 * that catalog. So a tile or menu item naming a key the catalog does not have is
 * satisfiable by a wildcard admin and NOBODY else: it renders SOON, forever,
 * with the page behind it working perfectly.
 *
 * That is not hypothetical. `dashboards.read` did it once. `neubit.read` did it
 * to EIGHT surfaces at the same time — Live, Playback, Alarms, Sites, Devices,
 * Linkage, Workflow and Ingest — because it was never a catalog key at all, and
 * the only account anyone tested with was the wildcard Administrator, for whom
 * every gate passes.
 *
 * So this reads the catalog itself. Both files are in this repo, so a key
 * renamed on the backend fails here on the same commit.
 */
import path from "node:path";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { LAUNCHER_MODES } from "./launcher";
import { configConsoles, deviceTabs, menuItems, streamTabs } from "./menu";

/** Every tile of one launcher mode, in the order it renders. */
function tiles(modeId: string) {
  const mode = LAUNCHER_MODES.find((m) => m.id === modeId)!;
  return mode.groups.flatMap((g) => g.tiles);
}

const CATALOG = path.resolve(
  __dirname,
  "../../..",
  "backend/core/app/auth/permissions.py",
);

/** Every `NAME = "some.key"` in the catalog enum. */
function catalogKeys(): Set<string> {
  const text = readFileSync(CATALOG, "utf8");
  const keys = [...text.matchAll(/^\s+[A-Z0-9_]+\s*=\s*"([a-z0-9_.]+)"/gm)].map((m) => m[1]!);
  return new Set(keys);
}

const NAV_PERMS: { where: string; perm: string }[] = [
  ...LAUNCHER_MODES.flatMap((mode) =>
    mode.groups.flatMap((g) =>
      g.tiles.filter((t) => t.perm).map((t) => ({ where: `launcher ${mode.id}/${t.label}`, perm: t.perm! })),
    ),
  ),
  ...[
    ["menuItems", menuItems],
    ["configConsoles", configConsoles],
    ["deviceTabs", deviceTabs],
    ["streamTabs", streamTabs],
  ].flatMap(([name, items]) =>
    (items as { title: string; perm?: string }[])
      .filter((i) => i.perm)
      .map((i) => ({ where: `${name} ${i.title}`, perm: i.perm! })),
  ),
];

describe("navigation gates", () => {
  it("reads a catalog that actually parsed", () => {
    // An empty set would make the assertion below pass for every key.
    const keys = catalogKeys();
    expect(keys.size).toBeGreaterThan(40);
    expect(keys.has("sites.read")).toBe(true);
  });

  it("checks a populated set of gates", () => {
    expect(NAV_PERMS.length).toBeGreaterThan(20);
  });

  it("name only permissions the catalog carries", () => {
    const keys = catalogKeys();
    const unknown = NAV_PERMS.filter((g) => !keys.has(g.perm)).map((g) => `${g.where} → ${g.perm}`);
    expect(unknown).toEqual([]);
  });
});


describe("the Surveillance launcher", () => {
  it("puts Events before Alarms — that is the workflow's own order", () => {
    // A recorder reports an event; an operator decides whether it is an incident;
    // only then is there an alarm to work.
    const labels = tiles("surv").map((t) => t.label);
    expect(labels.indexOf("Events")).toBeGreaterThan(-1);
    expect(labels.indexOf("Events")).toBeLessThan(labels.indexOf("Alarms"));
  });

  it("does not promise a separate Video Analytics console", () => {
    // An AI detection is an event like any other: the recorder's AI bridge reports
    // it, the supervisor mirrors it, and it lands in the feed beside motion and
    // tamper. A tile for it would be a second place to look for the same rows.
    expect(tiles("surv").map((t) => t.label)).not.toContain("Video Analytics");
  });

  it("reaches Events from the launcher, not from inside Playback", () => {
    // It rode the Streaming sub-tab strip, which said the estate's live device
    // feed was a sub-view of playing footage back.
    expect(streamTabs.map((t) => t.link)).not.toContain("/camera-events");
    expect(tiles("surv").map((t) => t.href)).toContain("/camera-events");
  });
});
