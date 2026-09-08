"use client";

// Applies the tenant's brand colours to the running console.
//
// WHY THIS EXISTS: `primary_color` and `accent_color` were saved and read back by
// the Branding form, and used by NOTHING else — the swatches next to the pickers
// were the only place either one appeared. An admin could set them, save, and the
// console looked identical. A control that changes nothing is the same fake option
// as a setting nothing reads.
//
// HOW: the console's palette is Tailwind v4 theme variables, and its utilities
// compile to `var(--color-nb-blue)` rather than to a literal — verified in the
// built CSS — so overriding the variable at runtime recolours every surface that
// uses the token.
//
// The lighter pair (`*b`, used for text and hover states on those surfaces) is
// derived with `color-mix` rather than exposed as two more pickers: a brand has a
// colour, not a colour and a hand-picked tint of it, and letting the two drift
// apart is how a palette stops looking deliberate.
//
// HONEST LIMIT: about forty places in the console write the default blue as a
// literal `rgba(96,165,250,…)` inside an arbitrary class — borders and glows that
// predate the token. Those do not follow the brand colour. Converting them is a
// separate sweep; until then a strong brand colour will sit beside a few blue
// hairlines.
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { api } from "@/lib/api";
import type { BrandingOut } from "@/lib/types";

/** token → the branding field that overrides it. */
const MAP = [
  { token: "--color-nb-blue", field: "primary_color" },
  { token: "--color-nb-teal", field: "accent_color" },
] as const;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * `#rrggbb` / `#rgb` only.
 *
 * Custom properties accept almost any token sequence — the CSSOM will happily
 * store `red; }` — and a rule that reads a nonsense value computes to nothing
 * rather than falling back. So a bad colour here is a blank surface, not a wrong
 * one, and the value is checked BEFORE it is written rather than trusted to be
 * rejected downstream. (jsdom happens to reject some of these itself, which is
 * why this is exported and tested directly instead of through the DOM.)
 */
export function isBrandColor(value: unknown): boolean {
  return typeof value === "string" && HEX.test(value.trim());
}

export default function BrandTheme() {
  const { data } = useQuery<BrandingOut>({
    queryKey: ["branding"],
    queryFn: () => api.get<BrandingOut>("/branding").then((r) => r.data),
    staleTime: 60_000,
  });

  useEffect(() => {
    const root = document.documentElement;
    for (const { token, field } of MAP) {
      const value = (data?.[field] || "").trim();
      if (!isBrandColor(value)) {
        // Nothing set, or not a colour: drop back to the stylesheet's own value
        // rather than leaving a previous tenant's override in place.
        root.style.removeProperty(token);
        root.style.removeProperty(`${token}b`);
        continue;
      }
      root.style.setProperty(token, value);
      root.style.setProperty(`${token}b`, `color-mix(in srgb, ${value} 62%, white)`);
    }
  }, [data]);

  return null;
}
