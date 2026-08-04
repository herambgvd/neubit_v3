"use client";

// Per-console section strip (header-less era). The global <Header> is retired, but
// several minimal-chrome CONSOLES carried their OWN section strip INSIDE that header
// — the modtab + sub-view segment that drives their ?view= navigation (Platform's
// 6-way segment, System's Assurance/Settings, Security's Policy/API-Keys, Sites'
// List/Map, Users & Roles' segment + Audit, etc.). Those are ESSENTIAL controls, so
// they live on here as a slim floating strip rendered only on their route. Everything
// else (the global domain nav) is gone; jump between sections via the ⊞ MENU dock.
//
// The strip is left-anchored and leaves clearance on the right for the floating
// GlobalNavDock (menu · search · bell · account).

import { Icon } from "@iconify/react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import UsersRolesStrip from "@/components/shell/UsersRolesStrip";
import { useAuth } from "@/lib/auth";

// Routes that render a console strip (must match AppLayout's minimalConsole set,
// minus /home which has no strip).
const STRIP_ROUTES = new Set([
  "/users", "/roles", "/audit", "/sites", "/map", "/general", "/workflow-config",
  "/ingest", "/config/security", "/platform", "/config/video-wall",
  "/config/linkage", "/config/onvif-server",
]);

export function hasConsoleStrip(pathname) {
  return STRIP_ROUTES.has(pathname);
}

const modtab =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-2.5 py-1 text-[12px] tracking-[.3px] text-nb-blueb";
const seg = (on) =>
  `flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition ${
    on ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb" : "border border-transparent text-nb-faint hover:text-nb-muted"
  }`;
const segBox = "flex gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]";

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
  const SOLO = isLinkage
    ? { label: "Linkage", icon: "heroicons-outline:bolt" }
    : isExternal
      ? { label: "External Access", icon: "heroicons-outline:signal" }
      : null;

  return (
    <div className="sticky top-0 z-40 shrink-0 border-b border-card-border bg-background/70 backdrop-blur">
      {/* Sits below the global top-clearance band (see AppLayout), so it clears the
          floating brand + dock and can use the full page width. */}
      <div className="flex h-12 items-center gap-2 px-6 lg:px-8">
        {usersRoles && (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <UsersRolesStrip active={pathname === "/roles" ? "roles" : "users"} />
            {can("audit.read") && (
              <Link
                href="/audit"
                title="Access change log — who / when / what, audit-signed"
                className="ml-auto flex items-center gap-1.5 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-3 py-1.5 text-[12px] tracking-[.4px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-outline:clipboard-document-list" className="text-[15px]" />
                Audit
              </Link>
            )}
          </div>
        )}

        {isWorkflow && (
          <div className={modtab}>
            <Icon icon="heroicons-outline:rectangle-stack" className="text-[14px]" />
            Workflow
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
            <div className="flex gap-0.5 overflow-x-auto rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]">
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
                  <Link key={s.v} href={`/platform?view=${s.v}`} className={`flex items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[11px] tracking-[.6px] transition ${on ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb" : "border border-transparent text-nb-faint hover:text-nb-muted"}`}>
                    <Icon icon={s.icon} className="text-[13px]" /> {s.label}
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
    </div>
  );
}
