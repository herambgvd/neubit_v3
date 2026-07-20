"use client";

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import CommandPalette from "@/components/CommandPalette";
import { FullPageLoader } from "@/components/ui/kit";
import Footer from "@/components/shell/Footer";
import Header from "@/components/shell/Header";
import SectionTabs from "@/components/shell/SectionTabs";
import VmsPopupHost from "@/features/vms/components/VmsPopupHost";
import { useAuth } from "@/lib/auth";
import {
  isConfigRoute,
  isDevicesRoute,
  isStreamingRoute,
  configTabs,
  deviceTabs,
  streamTabs,
} from "@/config/menu";

// A banner shown to every signed-in user when an admin sets an announcement.
function AnnouncementBanner() {
  const { data } = useQuery({
    queryKey: ["public-settings"],
    queryFn: () => api.get("/settings/public").then((r) => r.data),
    staleTime: 30_000,
  });
  const text = data?.announcement?.trim();
  if (!text) return null;
  return (
    <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 text-amber-500">
      <div className="w-full px-6 lg:px-8 py-2 flex items-center gap-2 text-[13px]">
        <Icon icon="heroicons-outline:megaphone" className="text-base shrink-0" />
        <span className="truncate">{text}</span>
      </div>
    </div>
  );
}

// Per-tenant license banner: warns when the tenant's license is in its grace
// window or has expired (resolved from GET /features via the auth context).
// Super-admins are always "active", so they never see it.
function LicenseBanner() {
  const { licenseState } = useAuth();
  if (licenseState === "grace") {
    return (
      <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 text-amber-500">
        <div className="w-full px-6 lg:px-8 py-2 flex items-center gap-2 text-[13px]">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-base shrink-0" />
          <span className="truncate">
            Your license is in its grace period — renew soon to avoid interruption.
          </span>
        </div>
      </div>
    );
  }
  if (licenseState === "expired") {
    return (
      <div className="shrink-0 bg-red-500/10 border-b border-red-500/20 text-red-500">
        <div className="w-full px-6 lg:px-8 py-2 flex items-center gap-2 text-[13px]">
          <Icon icon="heroicons-outline:x-circle" className="text-base shrink-0" />
          <span className="truncate">
            Your license has expired. Some features may be unavailable — contact your administrator.
          </span>
        </div>
      </div>
    );
  }
  return null;
}

// Auth-guarded application shell: horizontal top nav + full-width content.
export default function AppLayout({ children }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  if (status !== "authed") {
    return <FullPageLoader label={status === "anon" ? "Redirecting" : "Loading"} />;
  }

  // Full-height shell: header + footer stay fixed, only <main> scrolls. The Config
  // sub-tab bar appears under the header whenever we're inside the Config section.
  //
  // The Video Wall (/streaming) is an IMMERSIVE surface — it should fill the
  // remaining viewport EXACTLY, full-bleed, with no page padding and no page
  // scroll (a real-VMS control-room feel). So for that route only, <main> drops
  // its padding + scroll and becomes a bounded, overflow-hidden pane the wall
  // fills via h-full. Every other page keeps the padded, scrollable <main>.
  const immersiveWall = pathname === "/streaming";

  // CONTAINED pages (device inventory + access control): the PAGE must not scroll —
  // the toolbar stays fixed and only the content card scrolls internally. So <main>
  // becomes a bounded, overflow-hidden pane (keeps padding) that the page fills via
  // h-full + its own inner overflow. Keeps all three device pages consistent.
  const contained =
    pathname === "/devices/cameras" ||
    pathname === "/devices/nvr" ||
    pathname === "/devices/recorders" ||
    pathname === "/access-control" ||
    // Unified Playback is a control-room surface (source rail + synchronized grid +
    // master timeline) — the PAGE must not scroll; it fills the bounded pane via h-full.
    pathname === "/playback" ||
    // Config master/detail surfaces — same bounded, fill-the-pane layout as the device
    // pages (list-aside + detail card, no page scroll). Keeps all mgmt screens consistent.
    pathname === "/sites" ||
    pathname === "/users" ||
    pathname === "/roles" ||
    pathname === "/tags" ||
    pathname === "/config/patterns" ||
    pathname === "/config/linkage" ||
    pathname === "/workflow-config" ||
    pathname === "/ingest" ||
    pathname === "/config/video-wall" ||
    pathname === "/config/storage" ||
    // Sites map is a full-bleed map surface — fills the bounded pane (no page scroll).
    pathname === "/map";

  const mainClass = immersiveWall
    ? "flex-1 min-h-0 w-full overflow-hidden"
    : contained
      ? "flex-1 min-h-0 w-full overflow-hidden px-4 lg:px-5 py-3"
      : "app-scroll flex-1 overflow-y-auto w-full px-6 lg:px-8 py-6";

  // fixed inset-0: pin the shell to EXACTLY the viewport, immune to any parent
  // height-collapse. `h-screen` (100vh) was resolving short in this SCSS/flex context
  // (body h-full 100% chain), leaving the shell shorter than the viewport → footer
  // mid-page with black below (the "UI break"). Fixed positioning takes the shell out
  // of flow and sizes it to the viewport directly, so it can never render short.
  // overflow-hidden: the body never scrolls — scrollable pages scroll INSIDE <main>
  // (app-scroll / overflow-y-auto); contained/immersive pages clip.
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <Header />
      {isConfigRoute(pathname) && <SectionTabs tabs={configTabs} />}
      {isDevicesRoute(pathname) && <SectionTabs tabs={deviceTabs} />}
      {isStreamingRoute(pathname) && <SectionTabs tabs={streamTabs} />}
      <AnnouncementBanner />
      <LicenseBanner />
      <main className={mainClass}>{children}</main>
      <Footer />
      <CommandPalette />
      {/* App-wide operator popups (VMS linkage `popup` action → floating live camera). */}
      <VmsPopupHost />
    </div>
  );
}
