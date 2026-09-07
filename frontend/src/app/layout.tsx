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

export const metadata = {
  title: "Neubit",
  description: "Neubit — physical security command center",
};

// Runs before first paint, so nothing flashes:
//   • DARK-ONLY console: force the dark class and scrub any `theme: "light"` an
//     older build may have persisted, so no stored preference can resurrect the
//     retired light palette.
//   • Appearance: re-apply the operator's typeface and UI scale. These are on
//     <html> as data attributes and drive plain CSS (styles/theme.css), so they
//     take effect immediately — waiting for React would show one frame of the
//     default font, and the scale change would visibly reflow the whole page.
//
// The allowed values are inlined from the catalogue rather than trusted from
// storage: whatever is in localStorage goes into a DOM attribute, so it is only
// ever one of these literals.
const bootScript = `
document.documentElement.classList.add('dark');
try { localStorage.setItem('theme', 'dark'); } catch (e) {}
try {
  var d = document.documentElement;
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
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className="dark"
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
