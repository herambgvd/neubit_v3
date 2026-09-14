/**
 * Every icon name in the console must exist in the BUNDLED collection.
 *
 * This failure is invisible. Iconify treats a name it cannot resolve as "not
 * ready yet" — forever — so a wrong name renders as empty space with no error,
 * no fallback and nothing in the console. It is only ever noticed by someone
 * looking at the screen, which is how 13 of them accumulated: heroicons v2 names
 * (`square-3-stack-3d`, `viewfinder-circle`, `exclamation-triangle`) addressed
 * with the v1 `heroicons-outline:` / `heroicons-solid:` prefix, where they have
 * never existed.
 *
 * The predecessor of this test resolved names against the four COMPLETE icon
 * sets, because that is what the registry used to load — 2,106 icons on every
 * route to cover the 233 the app names. It also recorded the argument for that:
 * a few call sites "build a name at runtime", so a scan of literals is "a floor,
 * not a proof". Those call sites were then examined one by one, and the argument
 * turned out not to hold — every such name is a lookup in a table of string
 * LITERALS, which a scan sees. So this file now resolves against the curated
 * bundle, and the scan is the proof rather than the floor.
 *
 * The one name that genuinely is not in the source tree is an alert format's
 * operator-typed `icon`; it goes through `bundledIcon()`, tested below.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { IconifyJSON } from "@iconify/types";

import bundleJson from "./icons/icon-bundle.json";
import { Icon, bundledIcon } from "./icons";

const SRC = path.resolve(__dirname, "..");
const BUNDLE = bundleJson as unknown as IconifyJSON[];

function resolves(prefix: string, name: string): boolean {
  const set = BUNDLE.find((c) => c.prefix === prefix);
  // A prefix nothing registers can never resolve, whatever the name is.
  if (!set) return false;
  return Boolean(set.icons[name] || set.aliases?.[name]);
}

const ICON_LITERAL =
  /["'`](heroicons(?:-outline|-solid|-mini)?|svg-spinners|mdi):([a-z0-9-]+)["'`]/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Comments and JSDoc out, so PROSE ABOUT a bad icon name is not read as a use of
 * one. A comment explaining why `heroicons-outline:h1` does not exist failed this
 * guard, which would teach the next person to stop writing that comment.
 */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** name → the first file that uses it, so a failure says where to look. */
function iconsIn(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    const text = code(readFileSync(file, "utf8"));
    for (const match of text.matchAll(ICON_LITERAL)) {
      const key = `${match[1]}:${match[2]}`;
      if (!found.has(key)) found.set(key, path.relative(SRC, file));
    }
  }
  return found;
}

describe("every icon the console names is in the bundle", () => {
  const icons = iconsIn(sourceFiles(SRC));

  it("finds the icon literals at all — a scan that matches nothing proves nothing", () => {
    expect(icons.size).toBeGreaterThan(150);
  });

  it("resolves every one of them offline", () => {
    const broken = [...icons]
      .filter(([key]) => !resolves(key.split(":")[0], key.split(":").slice(1).join(":")))
      .map(([key, file]) => `${key}  ←  ${file}`);

    expect(broken, "these render as blank space, silently").toEqual([]);
  });

  /**
   * The bundle only stays small if nothing imports a whole published set again.
   * `@iconify-json/heroicons` alone is 1,288 icons; four of them were loaded on
   * 54 of 55 routes, and the import that did it read like any other import.
   */
  it("nothing in src/ pulls in a complete icon set", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => /from\s+["']@iconify-json\//.test(code(readFileSync(f, "utf8"))))
      .map((f) => path.relative(SRC, f));

    expect(offenders, "import the curated bundle via @/lib/icons instead").toEqual([]);
  });
});

/** A few real screens, rendered: the registry has to produce actual artwork. */
describe("the registered bundle draws", () => {
  const screens = [
    "features/core/audit/Audit.tsx",
    "features/access/components/EventsFeed.tsx",
    "features/core/sites/Sites.tsx",
    "features/core/users/Users.tsx",
    "features/workflow/components/config/FormatsTab.tsx",
    "components/floor-builder/DeviceManagementSidebar.tsx",
  ];

  for (const screen of screens) {
    it(`${screen}: every icon it names renders a non-empty <svg>`, () => {
      const names = [...iconsIn([path.join(SRC, screen)]).keys()];
      expect(names.length).toBeGreaterThan(0);

      const blank: string[] = [];
      for (const name of names) {
        const { container, unmount } = render(<Icon icon={name} />);
        const svg = container.querySelector("svg");
        if (!svg || svg.innerHTML.trim() === "") blank.push(name);
        unmount();
      }
      expect(blank, "rendered as empty space").toEqual([]);
    });
  }
});

describe("bundledIcon", () => {
  it("keeps a name the bundle can draw", () => {
    expect(bundledIcon("heroicons-outline:fire", "heroicons-outline:swatch")).toBe(
      "heroicons-outline:fire"
    );
  });

  it("substitutes for a name nothing can draw, rather than rendering nothing", () => {
    // What an operator typing into the alert-format icon field can produce.
    expect(bundledIcon("mdi:not-a-real-icon", "heroicons-outline:swatch")).toBe(
      "heroicons-outline:swatch"
    );
    expect(bundledIcon("", "heroicons-outline:swatch")).toBe("heroicons-outline:swatch");
    expect(bundledIcon(null, "heroicons-outline:swatch")).toBe("heroicons-outline:swatch");
  });
});
