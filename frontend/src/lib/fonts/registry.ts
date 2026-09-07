/**
 * Loads the faces the appearance catalogue offers, and binds each to a CSS
 * variable. `layout.tsx` puts `fontVars` on <body>; `theme.css` picks ONE of
 * them per `<html data-font>`.
 *
 * SELF-HOSTED, deliberately. `next/font/google` fetches the files at build time,
 * which quietly makes the build need the public internet — and this console is
 * installed on air-gapped networks (the same reason `lib/icons.ts` bundles its
 * icon set instead of hitting api.iconify.design). The five .woff2 in ./files
 * are the latin subset of each family's VARIABLE face: one file covers every
 * weight, ~185KB for the whole catalogue.
 *
 * Only this module may import `next/font`; everything else reads `catalog.ts`.
 */
import { GeistSans } from "geist/font/sans";
import localFont from "next/font/local";

const outfit = localFont({
  src: "./files/outfit.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-outfit",
});

const inter = localFont({
  src: "./files/inter.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-inter-sans",
});

const dmSans = localFont({
  src: "./files/dm-sans.woff2",
  weight: "100 1000",
  display: "swap",
  variable: "--font-dm-sans",
});

const publicSans = localFont({
  src: "./files/public-sans.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-public-sans",
});

/**
 * Not a UI choice — it backs the `font-mono` utility, which the console uses for
 * IDs, hashes and metrics. Without it those fell through to whatever monospace
 * the operator's OS happened to have.
 */
const jetBrainsMono = localFont({
  src: "./files/jetbrains-mono.woff2",
  weight: "100 800",
  display: "swap",
  variable: "--font-jetbrains-mono",
});

/** Every variable, in one className for <body>. The catalogue chooses among them. */
export const fontVars = [
  GeistSans.variable,
  outfit.variable,
  inter.variable,
  dmSans.variable,
  publicSans.variable,
  jetBrainsMono.variable,
].join(" ");
