"use client";

// The section nav that lives INSIDE the global top bar.
//
// Every page's second-level navigation used to render as its own bar UNDER the header
// (ConsoleStrip for the minimal-chrome consoles, SectionTabs for Devices/Streaming),
// costing a whole extra row of chrome on most screens. It now renders inline in the
// header between the brand and the dock cluster, so a page's own controls (Users ⇄
// Roles + Audit, Sites List ⇄ Map, Platform's sub-views, Devices/Streaming tabs) are
// always in the top bar and nowhere else.
//
// Route → nav is resolved here so GlobalNavDock stays a dumb container. Returns null
// on routes with no section nav (the bar then just carries brand + dock).

import { usePathname } from "next/navigation";

import ConsoleStrip, { hasConsoleStrip } from "@/components/shell/ConsoleStrip";
import SectionTabs from "@/components/shell/SectionTabs";
import {
  isDevicesRoute,
  isStreamingRoute,
  deviceTabs,
  streamTabs,
} from "@/config/menu";

export default function HeaderSectionNav() {
  const pathname = usePathname();

  if (hasConsoleStrip(pathname)) return <ConsoleStrip />;
  if (isDevicesRoute(pathname)) {
    return <SectionTabs tabs={deviceTabs} label="Devices" icon="heroicons-outline:video-camera" />;
  }
  if (isStreamingRoute(pathname)) {
    return <SectionTabs tabs={streamTabs} label="Streaming" icon="heroicons:signal" />;
  }
  return null;
}
