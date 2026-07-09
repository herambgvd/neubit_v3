"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Blocks,
  Building2,
  ChevronLeft,
  ChevronRight,
  Database,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Moon,
  Search,
  ScrollText,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserCircle,
  Users,
} from "lucide-react";

import { tokens } from "@/lib/api";
import { useTheme } from "@/components/theme";
import { useRequireSuperadmin } from "@/lib/useRequireSuperadmin";
import { ConfirmDialog } from "@/components/ui";
import { CommandPalette } from "@/components/command-palette";

// Grouped nav — a proper admin sidebar instead of a crowded top bar.
const GROUPS = [
  { label: "Overview", items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] },
  {
    label: "Tenancy",
    items: [
      { href: "/tenants", label: "Tenants", icon: Building2 },
      { href: "/users", label: "Users", icon: Users },
    ],
  },
  {
    label: "Platform",
    items: [
      { href: "/modules", label: "Modules", icon: Blocks },
      { href: "/platform-settings", label: "Platform Settings", icon: SlidersHorizontal },
      { href: "/audit", label: "Audit", icon: ScrollText },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/infrastructure", label: "Infrastructure", icon: ServerCog },
      { href: "/database", label: "Database", icon: Database },
    ],
  },
];

// Flat nav (incl. account pages) the command palette can jump to.
const PALETTE_NAV = [
  ...GROUPS.flatMap((g) => g.items),
  { href: "/profile", label: "Profile", icon: UserCircle },
  { href: "/security", label: "Security", icon: Lock },
];

export default function PanelLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, toggle: toggleTheme } = useTheme();
  const { status } = useRequireSuperadmin();
  const [collapsed, setCollapsed] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem("neubit.admin.sidebar") === "1");
  }, []);

  // Track the lg breakpoint so the icon-only collapse only applies on desktop —
  // the mobile drawer always shows full labels.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // ⌘K / Ctrl+K toggles the command palette anywhere in the panel.
  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function toggle() {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("neubit.admin.sidebar", next ? "1" : "0");
      return next;
    });
  }
  function logout() {
    tokens.clear();
    router.replace("/login");
  }

  if (status !== "ready") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted">
        Loading…
      </div>
    );
  }

  // Effective collapse: icon-only only on desktop.
  const c = collapsed && isDesktop;

  const paletteActions = [
    {
      id: "theme",
      label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
      icon: theme === "dark" ? Sun : Moon,
      run: toggleTheme,
    },
    { id: "logout", label: "Log out", icon: LogOut, run: () => setConfirmLogout(true) },
  ];

  const navLink = (href, label, Icon) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        title={c ? label : undefined}
        aria-current={active ? "page" : undefined}
        className={
          "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition " +
          (c ? "justify-center " : "") +
          (active
            ? "bg-hover font-medium text-foreground"
            : "text-muted hover:bg-hover hover:text-foreground")
        }
      >
        <Icon className="h-[18px] w-[18px] shrink-0" />
        {!c && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Mobile drawer backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={
          "fixed inset-y-0 left-0 z-50 flex h-screen w-60 shrink-0 flex-col border-r border-card-border bg-background backdrop-blur-xl transition-transform duration-200 " +
          "lg:sticky lg:top-0 lg:z-auto lg:translate-x-0 " +
          (mobileOpen ? "translate-x-0 " : "-translate-x-full lg:translate-x-0 ") +
          (c ? "lg:w-[68px] " : "lg:w-60 ")
        }
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b border-card-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-6 w-auto shrink-0 brightness-0 dark:invert dark:brightness-0" />
            {!c && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <ShieldCheck className="h-3 w-3" />
                Super-admin
              </span>
            )}
          </Link>
        </div>

        {/* Search launcher */}
        <div className="px-2 pt-3">
          <button
            onClick={() => setPaletteOpen(true)}
            title={c ? "Search (⌘K)" : undefined}
            className={
              "flex w-full items-center gap-3 rounded-lg border border-card-border bg-card px-3 py-2 text-[13px] text-muted transition hover:text-foreground " +
              (c ? "justify-center" : "")
            }
          >
            <Search className="h-[18px] w-[18px] shrink-0" />
            {!c && (
              <>
                <span className="flex-1 text-left">Search…</span>
                <kbd className="rounded border border-card-border bg-hover px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
              </>
            )}
          </button>
        </div>

        {/* Grouped nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {GROUPS.map((g) => (
            <div key={g.label} className="mb-2">
              {!c && (
                <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {g.label}
                </div>
              )}
              <div className="space-y-0.5">
                {g.items.map((it) => navLink(it.href, it.label, it.icon))}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer: account + theme + collapse */}
        <div className="space-y-0.5 border-t border-card-border p-2">
          {navLink("/profile", "Profile", UserCircle)}
          {navLink("/security", "Security", Lock)}
          <button
            onClick={toggleTheme}
            title={c ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}
            className={
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground " +
              (c ? "justify-center" : "")
            }
          >
            {theme === "dark" ? (
              <Sun className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <Moon className="h-[18px] w-[18px] shrink-0" />
            )}
            {!c && (theme === "dark" ? "Light mode" : "Dark mode")}
          </button>
          <button
            onClick={() => setConfirmLogout(true)}
            title={c ? "Log out" : undefined}
            className={
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground " +
              (c ? "justify-center" : "")
            }
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            {!c && "Log out"}
          </button>
          {/* Collapse is a desktop-only affordance. */}
          <button
            onClick={toggle}
            title={c ? "Expand" : "Collapse"}
            className={
              "hidden w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground lg:flex " +
              (c ? "justify-center" : "")
            }
          >
            {c ? (
              <ChevronRight className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <>
                <ChevronLeft className="h-[18px] w-[18px] shrink-0" />
                Collapse
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-card-border bg-background/80 px-4 backdrop-blur lg:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-5 w-auto brightness-0 dark:invert dark:brightness-0" />
          <div className="flex-1" />
          <button
            onClick={() => setPaletteOpen(true)}
            aria-label="Search"
            className="rounded-lg p-1.5 text-muted transition hover:bg-hover hover:text-foreground"
          >
            <Search className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-6 lg:px-8 lg:py-8">{children}</div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        navItems={PALETTE_NAV}
        actions={paletteActions}
      />

      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="Log out?"
        description="You'll need to sign in again to access the super-admin console."
        confirmLabel="Log out"
        variant="primary"
        onConfirm={() => {
          setConfirmLogout(false);
          logout();
        }}
      />
    </div>
  );
}
