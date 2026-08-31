"use client";

// Per-console section nav. Several minimal-chrome CONSOLES carry their own section
// controls — the modtab + sub-view segment that drives their ?view= navigation
// (Platform's 6-way segment, System's Assurance/Settings, Security's Policy/API-Keys,
// Sites' List/Map, Users & Roles' segment + Audit, etc.).
//
// These used to render as a SEPARATE strip under the global header. They now render
// INLINE INSIDE the global top bar (see HeaderSectionNav → GlobalNavDock), so every
// page has exactly one row of chrome. This component therefore returns bare inline
// content — no bar wrapper, no sticky/border/background of its own — and still
// self-guards by route (renders null off its consoles).

import { Icon } from "@iconify/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import UsersRolesStrip from "@/components/shell/UsersRolesStrip";
import { WORKFLOW_VIEWS } from "@/features/workflow/constants";
import { useAuth } from "@/lib/auth";

// Routes that render a console strip (must match AppLayout's minimalConsole set,
// minus /home which has no strip).
const STRIP_ROUTES = new Set<any>([
  "/users", "/roles", "/audit", "/sites", "/map", "/general", "/workflow-config",
  "/ingest", "/config/security", "/platform", "/config/video-wall",
  "/config/linkage", "/config/onvif-server", "/federation", "/storage",
  // Building Intelligence — one modtab plus a segment across the BUILT consoles.
  // The unbuilt Sense/Think surfaces are deliberately absent here: the launcher
  // already shows them as SOON, and a dead segment cell would be exactly the
  // "fabricated destination" this feature must not ship.
  "/bi/portfolio", "/bi/energy", "/bi/hvac", "/bi/water", "/bi/insights",
]);

export function hasConsoleStrip(pathname) {
  return STRIP_ROUTES.has(pathname);
}

const modtab =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-2.5 py-1 text-[12px] tracking-[.3px] text-nb-blueb";
const seg = (on) =>
  `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition ${
    on ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb" : "border border-transparent text-nb-faint hover:text-nb-muted"
  }`;
const segBox = "flex shrink-0 gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]";

export default function ConsoleStrip() {
  const pathname = usePathname();
  const { can } = useAuth();
  const view = useSearchParams().get("view");

  if (!hasConsoleStrip(pathname)) return null;

  const usersRoles = pathname === "/users" || pathname === "/roles";
  const isAudit = pathname === "/audit";
  const isSites = pathname === "/sites" || pathname === "/map";
  const isSystem = pathname === "/general";
  const isWorkflow = pathname === "/workflow-config";
  const isIngest = pathname === "/ingest";
  const isSecurity = pathname === "/config/security";
  const isPlatform = pathname === "/platform";
  const isVideoWall = pathname === "/config/video-wall";
  const isLinkage = pathname === "/config/linkage";
  const isExternal = pathname === "/config/onvif-server";
  const isFederation = pathname === "/federation";
  const isStorage = pathname === "/storage";
  const isBI = pathname.startsWith("/bi/");
  const SOLO = isLinkage
    ? { label: "Linkage", icon: "heroicons-outline:bolt" }
    : isExternal
      ? { label: "External Access", icon: "heroicons-outline:signal" }
      : isFederation
        ? { label: "Federation", icon: "heroicons-outline:share" }
        : isStorage
          ? { label: "Storage", icon: "heroicons-outline:circle-stack" }
          : null;

  return (
    // Bare inline content — the global header owns the bar chrome. nav-scroll +
    // overflow-x-auto so a wide segment (Platform's 6-way) scrolls instead of
    // squeezing the brand or the right-hand dock cluster on narrow viewports.
    <div className="nav-scroll flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {usersRoles && (
        <div className="flex min-w-0 items-center gap-2">
          <UsersRolesStrip active={pathname === "/roles" ? "roles" : "users"} />
          {can("audit.read") && (
            <Link
              href="/audit"
              title="Access change log — who / when / what, audit-signed"
              className="flex shrink-0 items-center gap-1.5 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-3 py-1 text-[12px] tracking-[.4px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
            >
              <Icon icon="heroicons-outline:clipboard-document-list" className="text-[15px]" />
              Audit
            </Link>
          )}
        </div>
      )}

      {isWorkflow && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:rectangle-stack" className="text-[14px]" />
            Workflow
          </div>
          <div className={segBox}>
            {WORKFLOW_VIEWS.map((s, i) => {
              // First entry is the default view — it owns the bare /workflow-config URL.
              const on = i === 0 ? !view || view === s.key : view === s.key;
              return (
                <Link key={s.key} href={`/workflow-config?view=${s.key}`} className={seg(on)}>
                  <Icon icon={s.icon} className="text-[14px]" /> {s.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {isIngest && (
        <div className={modtab}>
          <Icon icon="heroicons-outline:arrow-down-on-square-stack" className="text-[14px]" />
          Ingest
        </div>
      )}

      {SOLO && (
        <div className={modtab}>
          <Icon icon={SOLO.icon} className="text-[14px]" />
          {SOLO.label}
        </div>
      )}

      {isBI && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:building-office-2" className="text-[14px]" />
            Building Intelligence
          </div>
          <div className={segBox}>
            {[
              { href: "/bi/portfolio", label: "PORTFOLIO", icon: "heroicons-outline:building-office-2" },
              { href: "/bi/energy", label: "ENERGY", icon: "heroicons-outline:bolt" },
              { href: "/bi/hvac", label: "HVAC", icon: "heroicons-outline:cog-8-tooth" },
              { href: "/bi/water", label: "WATER", icon: "heroicons-outline:beaker" },
              { href: "/bi/insights", label: "INSIGHTS", icon: "heroicons-outline:chart-pie" },
            ].map((s) => (
              <Link key={s.href} href={s.href} className={seg(pathname === s.href)}>
                <Icon icon={s.icon} className="text-[14px]" /> {s.label}
              </Link>
            ))}
          </div>
        </div>
      )}

      {isVideoWall && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:computer-desktop" className="text-[14px]" />
            Video Wall
          </div>
          <Link
            href="/wall"
            title="Open the live Wall Console"
            className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1 text-[11.5px] tracking-[.5px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:tv" className="text-[14px]" /> LIVE WALL
          </Link>
        </div>
      )}

      {isPlatform && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:squares-2x2" className="text-[14px]" />
            Platform
          </div>
          <div className={segBox}>
            {[
              { v: "notifications", label: "NOTIFICATIONS", icon: "heroicons-outline:bell-alert" },
              { v: "branding", label: "BRANDING", icon: "heroicons-outline:swatch" },
              { v: "templates", label: "EMAIL TEMPLATES", icon: "heroicons-outline:envelope" },
              { v: "tags", label: "TAGS", icon: "heroicons-outline:tag" },
              { v: "health", label: "HEALTH", icon: "heroicons-outline:heart" },
              { v: "license", label: "LICENSE", icon: "heroicons-outline:check-badge" },
            ].map((s) => {
              const on = (view || "notifications") === s.v;
              return (
                <Link key={s.v} href={`/platform?view=${s.v}`} className={seg(on)}>
                  <Icon icon={s.icon} className="text-[14px]" /> {s.label}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {isSecurity && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:shield-exclamation" className="text-[14px]" />
            Security
          </div>
          <div className={segBox}>
            <Link href="/config/security?view=policy" className={seg(view !== "keys")}>
              <Icon icon="heroicons-outline:lock-closed" className="text-[14px]" /> POLICY
            </Link>
            <Link href="/config/security?view=keys" className={seg(view === "keys")}>
              <Icon icon="heroicons-outline:key" className="text-[14px]" /> API KEYS
            </Link>
          </div>
        </div>
      )}

      {isSystem && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:adjustments-horizontal" className="text-[14px]" />
            System
          </div>
          <div className={segBox}>
            <Link href="/general?view=assurance" className={seg(view !== "settings")}>
              <Icon icon="heroicons-outline:shield-check" className="text-[14px]" /> ASSURANCE
            </Link>
            <Link href="/general?view=settings" className={seg(view === "settings")}>
              <Icon icon="heroicons-outline:cog-6-tooth" className="text-[14px]" /> SETTINGS
            </Link>
          </div>
        </div>
      )}

      {isSites && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:map-pin" className="text-[14px]" />
            Sites
          </div>
          <div className={segBox}>
            <Link href="/sites" className={seg(pathname === "/sites")}>
              <Icon icon="heroicons-outline:list-bullet" className="text-[14px]" /> LIST
            </Link>
            <Link href="/map" className={seg(pathname === "/map")}>
              <Icon icon="heroicons-outline:map" className="text-[14px]" /> MAP
            </Link>
          </div>
        </div>
      )}

      {isAudit && (
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/users"
            title="Back to Users & Roles"
            className="flex shrink-0 items-center gap-1 rounded-[7px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1 text-[12px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-mini:chevron-left" className="text-[14px]" /> Users &amp; Roles
          </Link>
          <div className={modtab}>
            <Icon icon="heroicons-outline:clipboard-document-list" className="text-[14px]" />
            Audit Log
          </div>
        </div>
      )}
    </div>
  );
}
