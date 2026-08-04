import "simplebar-react/dist/simplebar.min.css";
import "@/styles/scss/app.scss";
import "@/styles/theme.css";

import { GeistSans } from "geist/font/sans";

import Providers from "@/components/Providers";

export const metadata = {
  title: "Neubit",
  description: "Neubit — physical security command center",
};

// DARK-ONLY console: force the dark class before first paint and scrub any
// `theme: "light"` an older build may have persisted, so no stored preference can
// flash (or stick) the retired light palette.
const noFlashScript = `
document.documentElement.classList.add('dark');
try { localStorage.setItem('theme', 'dark'); } catch (e) {}
`;

// Root font-size 14px keeps the whole UI compact (all rem-based sizing scales down).
export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark" style={{ fontSize: "14px" }} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly etc.) inject attributes
          into <body> before React hydrates — ignore that one-level attribute mismatch,
          not real content mismatches. */}
      <body
        suppressHydrationWarning
        className={`${GeistSans.className} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
