/**
 * The console's colour theme: Default (the navy console), Light or Dark — the
 * same three the Neubit NVR console offers.
 *
 * PURE — no React — because the root layout (a Server Component) builds its
 * pre-paint boot script from these constants. The React side is
 * `lib/appearance.tsx`, which stores the choice like the typeface: in
 * localStorage for this device (read before first paint) and in the user's
 * server preferences so it follows them to a new browser.
 *
 * A key here is the literal written to `<html data-theme>`, to localStorage and to
 * the server. Renaming one silently resets every operator who picked it.
 */

export const THEMES = ["default", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "default";

/** Where a device remembers its own choice. Read by the boot script in `app/layout.tsx`. */
export const THEME_STORAGE_KEY = "ui:theme";
/** The key the server stores the same choice under. */
export const THEME_PREF_KEY = "ui_theme";

export type ThemeOption = { key: Theme; label: string; note: string };

/** Order is the order the picker renders. */
export const THEME_OPTIONS: readonly ThemeOption[] = [
  { key: "default", label: "Default", note: "The console's navy look" },
  { key: "light", label: "Light", note: "White surfaces, slate ink" },
  { key: "dark", label: "Dark", note: "Black surfaces, grey ink" },
];

/** A stored or sent value; anything unknown is the default. */
export function parseTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : DEFAULT_THEME;
}

/** Draw the console in `theme` now. `.dark` stays on for the two dark themes,
 *  for the `dark:` variants still in the code. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme !== "light");
}
