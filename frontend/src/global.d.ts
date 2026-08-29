// Ambient declarations for globals and third-party props the app relies on at
// runtime but that carry no types of their own.

import "@iconify/react";

declare global {
  interface Window {
    /** h265web.js player, loaded from /public as a classic script tag. */
    H265webjsPlayer?: any;
    /** Guard flag for the one-time global AbortError swallow (see LivePlayer). */
    __neubitAbortSwallow?: boolean;
    /** GSAP ScrollTrigger + friends attach here when loaded via the plugin bundle. */
    ScrollTrigger?: any;
  }
}

declare module "@iconify/react" {
  // `IconProps` is a type alias, so it cannot be merged; the icon half of it is an
  // interface and can. Iconify forwards unknown props onto the rendered <svg>, and
  // several toolbars pass `title` for a native tooltip.
  interface IconifyIconProps {
    title?: string;
  }
}

export {};
