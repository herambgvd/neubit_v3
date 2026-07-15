"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";

// Generic second-level horizontal sub-tab bar (neubit_v2's two-tier pattern, rethemed to
// neubit_v3's Vercel tokens). Rendered by AppLayout under the header for a section (Config
// or Devices). Enabled tabs are perm-gated; unbuilt tabs render greyed with a "Soon" pill.
// Scrolls horizontally when it overflows.
export default function SectionTabs({ tabs }) {
  const pathname = usePathname();
  const { can, user } = useAuth();

  // `superadmin: true` tabs are VENDOR-ONLY (e.g. External Access) — hidden unless
  // the signed-in user is the platform super-admin, even if they hold the perm.
  const visible = tabs.filter(
    (t) =>
      t.disabled ||
      ((!t.superadmin || !!user?.is_superadmin) && (!t.perm || can(t.perm))),
  );

  return (
    <div className="shrink-0 border-b border-card-border bg-background/60 backdrop-blur">
      <nav className="nav-scroll flex items-stretch gap-0.5 overflow-x-auto px-6 lg:px-8">
        {visible.map((t) => {
          if (t.disabled) {
            return (
              <span
                key={t.title}
                title="Coming soon"
                aria-disabled="true"
                className="flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-[13px] text-muted/40 cursor-not-allowed select-none"
              >
                <Icon icon={t.icon} className="text-base shrink-0" />
                {t.title}
                <span className="ml-0.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-hover text-muted/70">
                  Soon
                </span>
              </span>
            );
          }
          const active = pathname === t.link || pathname.startsWith(`${t.link}/`);
          return (
            <Link
              key={t.title}
              href={t.link}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] transition ${
                active
                  ? "border-foreground text-foreground font-medium"
                  : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              <Icon icon={t.icon} className="text-base shrink-0" />
              {t.title}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
