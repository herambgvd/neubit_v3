/**
 * The admin console's typeface, kept in step with the operator console.
 *
 * SELF-HOSTED for the same reason as ../../../frontend: `next/font/google` would
 * make the build need the public internet, and this platform installs on
 * air-gapped networks. The file is the latin subset of Outfit's VARIABLE face —
 * one file, every weight, ~32KB.
 *
 * NO picker here, unlike the operator console: this panel has no account or
 * preferences screen to hang one on. If it ever grows one, port
 * frontend/src/lib/fonts/catalog.ts and frontend/src/lib/appearance.tsx.
 */
import localFont from "next/font/local";

export const outfit = localFont({
  src: "./files/outfit.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-outfit",
});
