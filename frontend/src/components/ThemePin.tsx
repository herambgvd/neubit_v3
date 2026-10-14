import type { ReactNode } from "react";

import type { Theme } from "@/lib/theme";

/**
 * Draw `children` in one theme whatever the operator picked: the sign-in and
 * landing pages are brand art, painted for the navy console, and stay navy in
 * Light and Dark too. `display: contents` adds no box, so layout is untouched;
 * the tokens still resolve against this element's own `data-theme`.
 */
export default function ThemePin({ theme = "default", children }: Readonly<{ theme?: Theme; children?: ReactNode }>) {
  return (
    <div data-theme={theme} className={theme === "light" ? "contents" : "dark contents"}>
      {children}
    </div>
  );
}
