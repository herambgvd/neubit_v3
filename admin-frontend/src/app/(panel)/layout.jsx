"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import {
  Blocks,
  Building2,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Lock,
  LogOut,
  Moon,
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
  { label: "System", items: [{ href: "/infrastructure", label: "Infrastructure", icon: ServerCog }] },
];

export default function PanelLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, toggle: toggleTheme } = useTheme();
  const { status } = useRequireSuperadmin();
  const [collapsed, setCollapsed] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem("neubit.admin.sidebar") === "1");
  }, []);

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

  const navLink = (href, label, Icon) => {
    const active = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        className={
          "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition " +
          (collapsed ? "justify-center " : "") +
          (active
            ? "bg-hover font-medium text-foreground"
            : "text-muted hover:bg-hover hover:text-foreground")
        }
      >
        <Icon className="h-[18px] w-[18px] shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside
        className={
          "sticky top-0 flex h-screen shrink-0 flex-col border-r border-card-border bg-background/60 backdrop-blur-xl transition-[width] duration-200 " +
          (collapsed ? "w-[68px]" : "w-60")
        }
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2 border-b border-card-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo/neubit_logo.svg" alt="Neubit" className="h-6 w-auto shrink-0 brightness-0 dark:invert dark:brightness-0" />
            {!collapsed && (
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/20 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
                <ShieldCheck className="h-3 w-3" />
                Super-admin
              </span>
            )}
          </Link>
        </div>

        {/* Grouped nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {GROUPS.map((g) => (
            <div key={g.label} className="mb-2">
              {!collapsed && (
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
            title={collapsed ? (theme === "dark" ? "Light mode" : "Dark mode") : undefined}
            className={
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground " +
              (collapsed ? "justify-center" : "")
            }
          >
            {theme === "dark" ? (
              <Sun className="h-[18px] w-[18px] shrink-0" />
            ) : (
              <Moon className="h-[18px] w-[18px] shrink-0" />
            )}
            {!collapsed && (theme === "dark" ? "Light mode" : "Dark mode")}
          </button>
          <button
            onClick={() => setConfirmLogout(true)}
            title={collapsed ? "Log out" : undefined}
            className={
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground " +
              (collapsed ? "justify-center" : "")
            }
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            {!collapsed && "Log out"}
          </button>
          <button
            onClick={toggle}
            title={collapsed ? "Expand" : "Collapse"}
            className={
              "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] text-muted transition hover:bg-hover hover:text-foreground " +
              (collapsed ? "justify-center" : "")
            }
          >
            {collapsed ? (
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

      {/* Full-width content */}
      <main className="min-w-0 flex-1">
        <div className="px-8 py-8">{children}</div>
      </main>

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
