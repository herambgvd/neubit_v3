/**
 * The brand colours have to reach the console, not just the swatch beside the
 * picker. `primary_color` and `accent_color` were saved and read back and used by
 * NOTHING else — an admin could set them, save, and nothing looked different.
 *
 * The console's utilities compile to `var(--color-nb-blue)` (checked in the built
 * CSS), so overriding the variable at runtime is what recolours the surfaces that
 * use the token. These cases pin the variable, not any particular surface.
 */
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stubApi } from "@/test/apiStub";
import { renderWithProviders } from "@/test/render";

import BrandTheme, { isBrandColor } from "./BrandTheme";

const root = () => document.documentElement;
const varOf = (name: string) => root().style.getPropertyValue(name);

beforeEach(() => root().removeAttribute("style"));
afterEach(() => root().removeAttribute("style"));

describe("BrandTheme", () => {
  it("paints the tenant's colours onto the tokens the console draws with", async () => {
    stubApi({ "GET /branding": { primary_color: "#ff0000", accent_color: "#00ff00" } });
    renderWithProviders(<BrandTheme />);

    await waitFor(() => expect(varOf("--color-nb-blue")).toBe("#ff0000"));
    expect(varOf("--color-nb-teal")).toBe("#00ff00");
  });

  it("derives the lighter pair rather than letting it drift from the brand", async () => {
    stubApi({ "GET /branding": { primary_color: "#ff0000", accent_color: "#00ff00" } });
    renderWithProviders(<BrandTheme />);

    // `*b` is the text/hover tint on those surfaces; a brand has a colour, not a
    // colour and an unrelated tint of it.
    await waitFor(() => expect(varOf("--color-nb-blueb")).toContain("color-mix"));
    expect(varOf("--color-nb-blueb")).toContain("#ff0000");
  });

  it("leaves the stylesheet's own colours alone when the tenant set none", async () => {
    stubApi({ "GET /branding": { primary_color: "", accent_color: null } });
    renderWithProviders(<BrandTheme />);

    await waitFor(() => expect(varOf("--color-nb-blue")).toBe(""));
    expect(varOf("--color-nb-teal")).toBe("");
  });

  /**
   * Tested on the predicate, NOT through the DOM. The first version wrote a bad
   * value and asserted the variable stayed empty — and passed with the guard
   * deleted, because jsdom rejects those values itself. A browser's CSSOM is far
   * more permissive with custom properties, so that test proved nothing about the
   * code it was meant to guard.
   */
  it("accepts a hex colour and nothing else", () => {
    expect(isBrandColor("#ff0000")).toBe(true);
    expect(isBrandColor("#f00")).toBe(true);
    expect(isBrandColor("  #123abc  ")).toBe(true);

    expect(isBrandColor("red; }")).toBe(false);
    expect(isBrandColor("javascript:x")).toBe(false);
    expect(isBrandColor("rgb(1,2,3)")).toBe(false);
    expect(isBrandColor("#12345")).toBe(false);
    expect(isBrandColor("")).toBe(false);
    expect(isBrandColor(null)).toBe(false);
  });

  it("renders nothing of its own", () => {
    stubApi({ "GET /branding": { primary_color: "#123456", accent_color: "#654321" } });
    const { container } = renderWithProviders(<BrandTheme />);
    expect(container).toBeEmptyDOMElement();
  });
});
