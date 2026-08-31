"use client";

import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

import { api } from "@/lib/api";
import CommandPalette from "@/components/CommandPalette";
import { FullPageLoader } from "@/components/ui/kit";
import Footer from "@/components/shell/Footer";
import GlobalNavDock from "@/components/shell/GlobalNavDock";
import VmsPopupHost from "@/features/vms/components/VmsPopupHost";
import { useAuth } from "@/lib/auth";

// A banner shown to every signed-in user when an admin sets an announcement.
function AnnouncementBanner() {
  const { data } = useQuery<any>({
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
export default function AppLayout({ children }: any) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === "anon") router.replace("/login");
  }, [status, router]);

  if (status !== "authed") {
    return <FullPageLoader label={status === "anon" ? "Redirecting" : "Loading"} />;
  }

  // Full-height shell: header + footer stay fixed, only <main> scrolls. A page's
  // section nav rides INSIDE the header bar (HeaderSectionNav) — no second nav row.
  //
  // The Video Wall (/streaming) is an IMMERSIVE surface — it should fill the
  // remaining viewport EXACTLY, full-bleed, with no page padding and no page
  // scroll (a real-VMS control-room feel). So for that route only, <main> drops
  // its padding + scroll and becomes a bounded, overflow-hidden pane the wall
  // fills via h-full. Every other page keeps the padded, scrollable <main>.
  // Both the single-operator Live wall (/streaming) and a shared Wall Console
  // (/wall/<id>) are full-bleed operations consoles with their OWN top toolbar —
  // the global header/submenu/footer are suppressed so they fill the viewport.
  const immersiveWall = pathname === "/streaming" || pathname.startsWith("/wall/");

  // The NeuBit HOME metro launcher is a full-bleed, single-viewport surface (its own
  // navy backdrop, no page padding) — it fills the bounded pane and scrolls internally.
  const home = pathname === "/home";

  // Alarms (/events) is a full-bleed navy console like Home/Streaming: its own
  // radial-navy backdrop + masthead should reach the pane edges (no page padding);
  // the board/map scrolls internally. Kept scrollable (not overflow-hidden) so long
  // alarm lists page normally.
  const eventsFull = pathname === "/events";

  // CONTAINED pages (device inventory + access control): the PAGE must not scroll —
  // the toolbar stays fixed and only the content card scrolls internally. So <main>
  // becomes a bounded, overflow-hidden pane (keeps padding) that the page fills via
  // h-full + its own inner overflow. Keeps all three device pages consistent.
  const contained =
    pathname === "/devices/cameras" ||
    pathname === "/devices/recorders" ||
    pathname === "/federation" ||
    pathname === "/storage" ||
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
    pathname === "/config/onvif-server" ||
    pathname === "/config/video-wall" ||
    pathname === "/general" ||
    pathname === "/workflow-config" ||
    pathname === "/ingest" ||
    pathname === "/config/security" ||
    pathname === "/platform" ||
    // Audit console — bounded pane; the entries table scrolls internally.
    pathname === "/audit" ||
    // Building Intelligence consoles. Portfolio scrolls internally (ConsoleScroll);
    // Energy / HVAC / Water are master-detail like the config surfaces. All of
    // them use ConsolePage, whose height math (`-my-3` bleed) assumes this
    // bounded pane — a category console added here and NOT added to this list
    // renders with the wrong height rather than not at all, which is the kind of
    // breakage that gets noticed late.
    pathname === "/bi/portfolio" ||
    pathname === "/bi/energy" ||
    pathname === "/bi/hvac" ||
    pathname === "/bi/water" ||
    pathname === "/bi/insights" ||
    // Sites map is a full-bleed map surface — fills the bounded pane (no page scroll).
    pathname === "/map";

  const mainClass = immersiveWall || home
    ? "flex-1 min-h-0 w-full overflow-hidden"
    : eventsFull
      ? "app-scroll flex-1 overflow-y-auto w-full"
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
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-background"
      style={home ? { background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" } : undefined}
    >
      {/* Global header BAR — a real in-flow slim bar (⊞ MENU navigator · NeuBit brand
          → Home · THE PAGE'S OWN SECTION NAV · search · notifications · account). NOT
          floating, so page content sits cleanly below it and nothing overlaps. The old
          domain top-nav (Dashboard/Devices/Streaming/Incidents) is gone — navigation is
          the MENU overlay + Home launcher. Every page's section nav (the console strips
          and the Devices/Streaming tabs) renders INSIDE this bar via HeaderSectionNav,
          so there is no second nav row below the header any more. Suppressed on the
          immersive wall (/streaming, /wall/*), which carries its own toolbar. */}
      {!immersiveWall && <GlobalNavDock home={home} />}
      {!immersiveWall && <AnnouncementBanner />}
      {!immersiveWall && <LicenseBanner />}
      <main className={mainClass}>{children}</main>
      {/* HOME renders its own GVD lockup; the copyright footer bar is hidden there
          to match the mockup's minimal single-viewport launcher. Also hidden on the
          immersive wall. */}
      {!home && !immersiveWall && <Footer />}
      <CommandPalette />
      {/* App-wide operator popups (VMS linkage `popup` action → floating live camera). */}
      <VmsPopupHost />
    </div>
  );
}
