/**
 * STRUCTURAL, not behavioural. The catalogue, the font loader and the stylesheet
 * are three files that must agree on the same set of keys, and every way they can
 * disagree fails SILENTLY — a face that is offered but never loaded, or offered
 * but not switched to, just renders the default and says nothing. Nobody notices
 * until an operator picks it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_FONT, DEFAULT_SCALE, FONT_OPTIONS, SCALE_OPTIONS } from "./catalog";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8");
const registry = read("./registry.ts");
const themeCss = read("../../styles/theme.css");

describe("the appearance catalogue agrees with what ships", () => {
  it("loads and exports a face for every option it offers", () => {
    const vars = registry.slice(registry.indexOf("export const fontVars"));
    for (const option of FONT_OPTIONS) {
      if (option.cssVar === "--font-geist-sans") {
        // Geist arrives pre-loaded from the `geist` package, not from ./files.
        expect(registry).toContain("GeistSans");
        expect(vars).toContain("GeistSans.variable");
        continue;
      }
      // Declared...
      expect(registry, `${option.key} is offered but ${option.cssVar} is never bound`).toContain(
        `variable: "${option.cssVar}"`,
      );
      // ...and actually put on <body>, or the variable resolves to nothing.
      const local = registry.match(new RegExp(String.raw`const (\w+) = localFont\(\{[^}]*${option.cssVar}`, "s"));
      expect(local, `no local const binds ${option.cssVar}`).not.toBeNull();
      expect(vars, `${option.cssVar} is loaded but missing from fontVars`).toContain(`${local![1]}.variable`);
    }
  });

  it("has a stylesheet rule for every non-default typeface", () => {
    for (const option of FONT_OPTIONS) {
      if (option.key === DEFAULT_FONT) continue; // the default is the bare :root value
      expect(themeCss, `data-font="${option.key}" has no rule, so it renders the default`).toContain(
        `html[data-font="${option.key}"]`,
      );
    }
    expect(themeCss).toContain(`var(${FONT_OPTIONS.find((o) => o.key === DEFAULT_FONT)!.cssVar})`);
  });

  it("has a root size for every scale, and the default matches :root", () => {
    for (const option of SCALE_OPTIONS) {
      expect(themeCss, `data-ui-scale="${option.key}" has no rule`).toContain(
        `html[data-ui-scale="${option.key}"]`,
      );
      expect(themeCss).toContain(`${option.px}px`);
    }
    const fallback = SCALE_OPTIONS.find((o) => o.key === DEFAULT_SCALE)!;
    expect(themeCss, "the :root size must be the default scale, or the first paint jumps").toContain(
      `--ui-root-size: ${fallback.px}px`,
    );
  });

  it("lets the scale drive the root size instead of the layout pinning it", () => {
    const layout = read("../../app/layout.tsx");
    expect(layout, "an inline font-size on <html> outranks the stylesheet").not.toMatch(/fontSize/);
    expect(themeCss).toContain("font-size: var(--ui-root-size)");
  });
});
