/**
 * The appearance catalogue: which typefaces an operator may pick, and at what
 * scale. PURE DATA — no `next/font` import — so the picker (a client component)
 * and the tests can read it without pulling the font loader in behind them.
 * `registry.ts` is the only module that actually loads the files.
 *
 * A key here is the literal written to `<html data-font>` / `<html data-ui-scale>`,
 * to localStorage, and to the user's server-side preferences. Renaming one
 * silently resets every operator who had picked it, so don't.
 */

/** Where a device remembers its own choice. Read by the boot script in `app/layout.tsx`. */
export const FONT_STORAGE_KEY = "ui:font";
export const SCALE_STORAGE_KEY = "ui:scale";

export type FontKey = "outfit" | "geist" | "inter" | "dmSans" | "publicSans";

export type FontOption = {
  key: FontKey;
  label: string;
  /** The CSS variable `registry.ts` binds the loaded face to. */
  cssVar: string;
  note: string;
};

/** Order is the order the picker renders. */
export const FONT_OPTIONS: readonly FontOption[] = [
  { key: "outfit", label: "Outfit", cssVar: "--font-outfit", note: "Geometric, open — the console default" },
  { key: "geist", label: "Geist", cssVar: "--font-geist-sans", note: "Neutral and tight" },
  { key: "inter", label: "Inter", cssVar: "--font-inter-sans", note: "Built for small UI text" },
  { key: "dmSans", label: "DM Sans", cssVar: "--font-dm-sans", note: "Soft, low contrast" },
  { key: "publicSans", label: "Public Sans", cssVar: "--font-public-sans", note: "Plain, high legibility" },
] as const;

export const DEFAULT_FONT: FontKey = "outfit";

export type ScaleKey = "xs" | "sm" | "md" | "lg" | "xl";

export type ScaleOption = { key: ScaleKey; label: string; px: number };

/**
 * The ROOT font size. Nearly everything in the console is rem-based, so this one
 * number scales the whole product — spacing included, not just glyphs.
 */
export const SCALE_OPTIONS: readonly ScaleOption[] = [
  { key: "xs", label: "Compact", px: 12 },
  { key: "sm", label: "Small", px: 13 },
  { key: "md", label: "Default", px: 14 },
  { key: "lg", label: "Large", px: 15 },
  { key: "xl", label: "Extra large", px: 16 },
] as const;

/** 13px, one step below the 14px the console shipped with: denser by request. */
export const DEFAULT_SCALE: ScaleKey = "sm";

const FONT_KEYS = new Set<string>(FONT_OPTIONS.map((o) => o.key));
const SCALE_KEYS = new Set<string>(SCALE_OPTIONS.map((o) => o.key));

/** Anything unrecognised — a stale key, a hand-edited cookie — falls back. */
export function parseFont(value: unknown): FontKey {
  return typeof value === "string" && FONT_KEYS.has(value) ? (value as FontKey) : DEFAULT_FONT;
}

export function parseScale(value: unknown): ScaleKey {
  return typeof value === "string" && SCALE_KEYS.has(value) ? (value as ScaleKey) : DEFAULT_SCALE;
}

/** For a live preview: render text in a face that may not be the active one. */
export function fontStack(key: FontKey): string {
  const option = FONT_OPTIONS.find((o) => o.key === key) ?? FONT_OPTIONS[0];
  return `var(${option.cssVar}), system-ui, sans-serif`;
}
