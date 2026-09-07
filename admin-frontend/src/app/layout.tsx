import "@/styles/globals.css";
import "@/styles/theme.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";

import Providers from "@/components/Providers";
import { outfit } from "@/lib/fonts/registry";

export const metadata: Metadata = {
  title: "Neubit Admin",
  description: "Neubit — platform super-admin console",
};

// Set the theme class before first paint to avoid a flash (reads localStorage).
// Defaults to dark when nothing is saved. We do NOT hardcode `className="dark"`
// on <html>: this script is the sole authority, so a saved "light" choice is
// never overridden when React regenerates the tree after a hydration hiccup.
const noFlashScript = `
try {
  var t = localStorage.getItem('theme');
  document.documentElement.classList.toggle('dark', t !== 'light');
} catch (e) { document.documentElement.classList.add('dark'); }
`;

// Root font-size 13px keeps the UI compact (rem-based sizing scales down with it).
// Matches the operator console's default; that console lets each user change it,
// this one has no preferences screen to offer the choice on.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning on <html>: the no-flash script mutates the class
    // before hydration, so the server/client class can differ by design.
    <html lang="en" style={{ fontSize: "13px" }} suppressHydrationWarning>
      {/* suppressHydrationWarning on <body>: browser extensions (Grammarly etc.)
          inject data-* attributes here before React hydrates, which would
          otherwise trip a hydration mismatch and force a full re-render. */}
      <body
        className={`${outfit.className} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
        {/* beforeInteractive → Next hoists this into the server HTML head, so it
            runs before paint without the React "script tag" warning. */}
        <Script id="theme-no-flash" strategy="beforeInteractive">
          {noFlashScript}
        </Script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
