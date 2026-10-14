import type { ReactNode } from "react";

import "simplebar-react/dist/simplebar.min.css";
import "@/styles/scss/app.scss";
import "@/styles/theme.css";

import Providers from "@/components/Providers";
import {
  DEFAULT_FONT,
  DEFAULT_SCALE,
  FONT_OPTIONS,
  FONT_STORAGE_KEY,
  SCALE_OPTIONS,
  SCALE_STORAGE_KEY,
} from "@/lib/fonts/catalog";
import { fontVars } from "@/lib/fonts/registry";
import { DEFAULT_THEME, THEMES, THEME_STORAGE_KEY } from "@/lib/theme";

export const metadata = {
  title: "Neubit",
  description: "Neubit — physical security command center",
};

// Runs before first paint, so nothing flashes: re-apply the operator's colour
// theme, typeface and UI scale. These are on <html> as data attributes (plus the
// `dark` class for the two dark themes) and drive plain CSS (styles/theme.css),
// so they take effect immediately — waiting for React would show one frame of the
// default look, and the scale change would visibly reflow the whole page.
//
// The theme reads its own key (`ui:theme`), never the `theme` key older builds
// wrote: that one held a retired light palette's name, not the operator's choice.
//
// The allowed values are inlined from the catalogue rather than trusted from
// storage: whatever is in localStorage goes into a DOM attribute, so it is only
// ever one of these literals.
const bootScript = `
try {
  var d = document.documentElement;
  var themes = ${JSON.stringify(THEMES)};
  var t = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
  if (themes.indexOf(t) !== -1) {
    d.setAttribute('data-theme', t);
    if (t === 'light') d.classList.remove('dark');
  }
  var fonts = ${JSON.stringify(FONT_OPTIONS.map((o) => o.key))};
  var scales = ${JSON.stringify(SCALE_OPTIONS.map((o) => o.key))};
  var f = localStorage.getItem(${JSON.stringify(FONT_STORAGE_KEY)});
  var s = localStorage.getItem(${JSON.stringify(SCALE_STORAGE_KEY)});
  if (fonts.indexOf(f) !== -1) d.setAttribute('data-font', f);
  if (scales.indexOf(s) !== -1) d.setAttribute('data-ui-scale', s);
} catch (e) {}
`;

// The root font size comes from `data-ui-scale` (theme.css), NOT from an inline
// style here — an inline style would outrank the stylesheet and pin every
// operator to one size.
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className="dark"
      data-theme={DEFAULT_THEME}
      data-font={DEFAULT_FONT}
      data-ui-scale={DEFAULT_SCALE}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootScript }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly etc.) inject attributes
          into <body> before React hydrates — ignore that one-level attribute mismatch,
          not real content mismatches. */}
      <body suppressHydrationWarning className={`${fontVars} antialiased bg-background text-foreground`}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
