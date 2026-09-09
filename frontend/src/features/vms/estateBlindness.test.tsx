/**
 * EVERY CAMERA PICKER MUST SEE THE WHOLE ESTATE.
 *
 * This is the same bug, found for the fifth time on five screens: a surface asks
 * `/vms/cameras` — the rows THIS service owns — and on a single-ownership estate
 * that list is empty, because every camera belongs to a recorder. The screen then
 * shows an empty picker, or prints a raw uuid where a camera name belongs, and
 * both read as "the estate has nothing" rather than "I asked the wrong half".
 *
 * It has been fixed on the wall rail, Patterns, Playback, the Camera-events
 * filter, the Video-wall console and kiosk, and the Reports narrowing. The test
 * that keeps it fixed is a SOURCE SCAN, because the next screen to grow a picker
 * is the one nobody remembers to write a render test for.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const FEATURES = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Strip comments — this file's own prose names the call it forbids. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// The two places allowed to ask for the LOCAL half on its own, and why.
const ALLOWED = new Set([
  // The merge itself — it asks both halves and is what everything else uses.
  "vms/hooks/useEstateCameras.ts",
  // The Cameras console lists local and federated separately ON PURPOSE: its job
  // is showing which recorder owns what, so the split is the content.
  "vms/Cameras.tsx",
  // Recorders shows a recorder's own cameras beside the VMS-owned ones for the
  // same reason.
  "vms/Recorders.tsx",
  // Playback's picker is an explicit two-tab choice between the two stores, and
  // its tabs name which is which.
  "vms/components/UnifiedPlayback.tsx",
  // Home counts both halves — it fetches the federated list separately, right
  // below, so the Live tile's count is the whole estate.
  "core/system/Home.tsx",
  // The map's estate roll-up asks for both halves as two of its parallel
  // queries and merges them before the status lookup.
  "core/sites/useEstateOps.ts",
]);

describe("camera pickers", () => {
  it("scans the real feature tree", () => {
    expect(sourceFiles(FEATURES).length).toBeGreaterThan(100);
  });

  it("ask for the whole estate, not just this service's own cameras", () => {
    const offenders = sourceFiles(FEATURES)
      .filter((f) => /vms\.cameras\.list\s*\(/.test(code(readFileSync(f, "utf8"))))
      .map((f) => path.relative(FEATURES, f))
      .filter((rel) => !ALLOWED.has(rel));

    expect(offenders).toEqual([]);
  });

  it("keeps the allow-list honest — every entry still exists", () => {
    // An allow-list naming a deleted file silently widens itself.
    for (const rel of ALLOWED) {
      expect(() => statSync(path.join(FEATURES, rel))).not.toThrow();
    }
  });
});
