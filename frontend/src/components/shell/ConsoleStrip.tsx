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
import { PLANT_HREF, plantHref } from "@/features/bi/plant/routes";
import { WORK_HREF, workHrefFor } from "@/features/bi/work/routes";
import { SETUP_HREF, SETUP_TASKS, STRANDED_HREF, taskOfPath } from "@/features/bi/setup/routes";
import { WORKFLOW_VIEWS } from "@/features/workflow/constants";
import { useAuth } from "@/lib/auth";

// Routes that render a console strip (must match AppLayout's minimalConsole set,
// minus /home which has no strip).
const STRIP_ROUTES = new Set<string>([
  "/users", "/roles", "/audit", "/sites", "/map", "/system", "/workflow-config",
  "/ingest", "/config/security", "/platform", "/config/video-wall",
  "/config/linkage", "/federation", "/storage",
  "/config/patterns",
  // Building Intelligence — one modtab plus a segment across the LAYERS.
  // The unbuilt Sense/Think surfaces are deliberately absent here: the launcher
  // already shows them as SOON, and a dead segment cell would be exactly the
  // "fabricated destination" this feature must not ship.
  //
  "/bi/portfolio", "/bi/energy", "/bi/hvac", "/bi/water", "/bi/insights", "/bi/ratings",
  // L3 PLANT — one building's plant. Its cell appears only in a building scope.
  PLANT_HREF,
  // GATE 6 — what the estate is saying that somebody has to act on.
  WORK_HREF,
  // SETUP — the checklist and every task under it. The old worklist routes
  // (/bi/duplicates, /bi/placement, /bi/succession, /bi/metrics) redirect here.
  SETUP_HREF, ...SETUP_TASKS.map((t) => t.href), STRANDED_HREF,
]);

export function hasConsoleStrip(pathname: string | null | undefined): boolean {
  return pathname != null && STRIP_ROUTES.has(pathname);
}

const modtab =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-2.5 py-1 text-[12px] tracking-[.3px] text-nb-blueb";
const seg = (on: boolean) =>
  `flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition ${
    on ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb" : "border border-transparent text-nb-faint hover:text-nb-muted"
  }`;
const segBox = "flex shrink-0 gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]";

/** Setup's own segment: the checklist, then the tasks in pipeline order. */
const SETUP_CELLS = [
  { href: SETUP_HREF, label: "CHECKLIST", icon: "heroicons-outline:list-bullet", title: "How much of setup is done" },
  ...SETUP_TASKS.map((t) => ({
    href: t.href,
    label: t.short,
    icon: t.icon,
    title: t.gate ? `Gate ${t.gate} · ${t.label}` : t.label,
  })),
];

/** Pages that get a single chip in the strip instead of a segmented control. */
const SOLO_PAGES: Record<string, { label: string; icon: string }> = {
  "/config/linkage": { label: "Linkage", icon: "heroicons-outline:bolt" },
  "/federation": { label: "Federation", icon: "heroicons-outline:share" },
  "/storage": { label: "Storage", icon: "heroicons-outline:circle-stack" },
};

export default function ConsoleStrip() {
  const pathname = usePathname();
  const { can } = useAuth();
  const params = useSearchParams();
  const view = params.get("view");
  // Building Intelligence's second axis. A domain console is ESTATE-WIDE
  // without it and ONE BUILDING with it, and both are real destinations — see
  // the segment below, which carries it rather than silently dropping it.
  const biSite = params.get("site");

  if (!hasConsoleStrip(pathname)) return null;

  const usersRoles = pathname === "/users" || pathname === "/roles";
  const isAudit = pathname === "/audit";
  const isSites = pathname === "/sites" || pathname === "/map";
  const isSystem = pathname === "/system";
  const isWorkflow = pathname === "/workflow-config";
  const isIngest = pathname === "/ingest";
  const isSecurity = pathname === "/config/security";
  const isPlatform = pathname === "/platform";
  const isVideoWall = pathname === "/config/video-wall";
  const isPatterns = pathname === "/config/patterns";
  const isBI = pathname.startsWith("/bi/");
  const SOLO = SOLO_PAGES[pathname] ?? null;
  const isSetup = pathname === SETUP_HREF || pathname.startsWith(`${SETUP_HREF}/`);
  // The Setup cell a path lights; the stranded-role worklist lights ROLES.
  const setupTask = isSetup ? taskOfPath(pathname) : null;
  const setupLit = setupTask ? SETUP_TASKS.find((t) => t.id === setupTask)!.href : SETUP_HREF;

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
          {isSetup ? (
            // SETUP. Not a layer: the way back is to Building, and the segment
            // is Setup's own — the checklist, then the tasks in gate order.
            <>
              <Link
                href="/bi/portfolio"
                title="Back to Building"
                className="flex shrink-0 items-center gap-1 rounded-[7px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1 text-[12px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                <Icon icon="heroicons-mini:chevron-left" className="text-[14px]" /> Building
              </Link>
              <div className={segBox} aria-label="Setup">
                {SETUP_CELLS.map((c) => (
                  <Link key={c.href} href={c.href} title={c.title} className={seg(setupLit === c.href)}>
                    <Icon icon={c.icon} className="text-[14px]" /> {c.label}
                  </Link>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className={segBox}>
                {[
                  // L1, then its domains. The order is the drill, not a menu.
                  { href: "/bi/portfolio", label: "BUILDING", icon: "heroicons-outline:building-office-2" },
                  { href: "/bi/energy", label: "ENERGY", icon: "heroicons-outline:bolt", domain: true },
                  { href: "/bi/hvac", label: "HVAC", icon: "heroicons-outline:cog-8-tooth", domain: true },
                  { href: "/bi/water", label: "WATER", icon: "heroicons-outline:beaker", domain: true },
                  // L3 — one building's plant. Only a building scope has one, so
                  // the cell exists only when a building is in force: estate-wide
                  // there is no plant to open, and a cell that opened a picker
                  // would be a second Building.
                  ...(biSite ? [{ href: PLANT_HREF, label: "PLANT", icon: "heroicons-outline:cpu-chip", plant: true }] : []),
                  // Gate 6's worklist. Not Setup: Setup describes the building
                  // once, this is what today's readings are asking for. It keeps
                  // the building in scope when there is one.
                  { href: WORK_HREF, label: "WORK", icon: "heroicons-outline:bolt", work: true },
                  { href: "/bi/insights", label: "INSIGHTS", icon: "heroicons-outline:chart-pie" },
                  { href: "/bi/ratings", label: "RATINGS", icon: "heroicons-outline:star" },
                  // Every piece of BI configuration, behind its checklist.
                  { href: SETUP_HREF, label: "SETUP", icon: "heroicons-outline:adjustments-horizontal" },
                ].map((s) => (
                  <Link
                    key={s.href}
                    // THE SCOPE TRAVELS WITH THE CELL. A domain console is two
                    // screens under one route — the whole estate without
                    // `?site=`, one building with it — so a cell that dropped
                    // the param would move an operator from "Aeon Tower's
                    // energy" to "every building's energy" while looking like a
                    // filter change. Only the domains carry it: Building,
                    // Insights and Ratings have no site scope to keep.
                    href={
                      "plant" in s && biSite
                        ? plantHref(biSite)
                        : "work" in s
                          ? workHrefFor(biSite)
                          : "domain" in s && s.domain && biSite
                            ? `${s.href}?site=${encodeURIComponent(biSite)}`
                            : s.href
                    }
                    className={seg(pathname === s.href)}
                  >
                    <Icon icon={s.icon} className="text-[14px]" /> {s.label}
                  </Link>
                ))}
              </div>
              {biSite && (
                // WHICH SCOPE, said in the chrome. The console below says it at
                // length; this is what a reader sees without scrolling, and it
                // is the one control that leaves the building scope on purpose.
                <Link
                  // A plant has no estate-wide form: leaving the building from
                  // L3 goes back to every building, not to an unscoped plant.
                  href={pathname === PLANT_HREF ? "/bi/portfolio" : pathname}
                  title={
                    pathname === PLANT_HREF
                      ? "Leave the building — back to every building"
                      : "Leave the building scope — the same domain across the whole estate"
                  }
                  className="flex shrink-0 items-center gap-1 rounded-[7px] border border-[rgba(96,165,250,.45)] bg-[rgba(96,165,250,.12)] px-2.5 py-1 text-[11.5px] text-nb-blueb transition hover:border-nb-blue"
                >
                  <Icon icon="heroicons-outline:map-pin" className="text-[13px]" /> ONE BUILDING
                  <Icon icon="heroicons-mini:x-mark" className="text-[13px]" />
                </Link>
              )}
            </>
          )}
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
            <Icon icon="heroicons:tv" className="text-[14px]" /> LIVE WALL
          </Link>
        </div>
      )}

      {isPatterns && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:rectangle-group" className="text-[14px]" />
            Patterns
          </div>
          <div className={segBox}>
            {[
              { v: "patterns", label: "PATTERNS", icon: "heroicons-outline:squares-2x2" },
              { v: "groups", label: "GROUPS", icon: "heroicons-outline:video-camera" },
            ].map((s) => {
              // "patterns" is the default view and owns the bare /config/patterns URL,
              // the same deal Platform's "notifications" and Workflow's first view have.
              const on = (view || "patterns") === s.v;
              return (
                <Link key={s.v} href={`/config/patterns?view=${s.v}`} className={seg(on)}>
                  <Icon icon={s.icon} className="text-[14px]" /> {s.label}
                </Link>
              );
            })}
          </div>
          {/* A pattern exists to rotate on the live wall — the same relationship
              Video Wall has with the Wall Console, so it gets the same jump. */}
          <Link
            href="/streaming"
            title="Open the live wall"
            className="flex shrink-0 items-center gap-1.5 rounded-[7px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1 text-[11.5px] tracking-[.5px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons:tv" className="text-[14px]" /> LIVE WALL
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
              { v: "config", label: "CONFIG", icon: "heroicons-outline:adjustments-horizontal" },
              { v: "templates", label: "TEMPLATES", icon: "heroicons-outline:envelope" },
              { v: "tags", label: "TAGS", icon: "heroicons-outline:tag" },
              { v: "health", label: "HEALTH", icon: "heroicons-outline:heart" },
              { v: "license", label: "LICENSE", icon: "heroicons-outline:check-badge" },
            ].map((s) => {
              // The default view, and the two keys it replaced — an old link
              // must not leave the segment bar with nothing lit.
              const on =
                s.v === "config"
                  ? !view || ["config", "notifications", "branding"].includes(view)
                  : view === s.v;
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

      {/* No segment: Assurance and Settings are one page now. Posture and the
          settings that produce it read together, and neither filled a screen on
          its own. */}
      {isSystem && (
        <div className="flex min-w-0 items-center gap-2">
          <div className={modtab}>
            <Icon icon="heroicons-outline:adjustments-horizontal" className="text-[14px]" />
            System
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
