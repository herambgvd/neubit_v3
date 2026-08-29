"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { useAuth } from "@/lib/auth";

// Generic second-level section nav (Devices / Streaming). It used to render as its own
// full-width underlined tab bar under the header; it now renders INLINE INSIDE the
// global top bar (see HeaderSectionNav → GlobalNavDock) as a section modtab + a
// segmented pill group, matching the console section nav. Enabled tabs are perm-gated;
// unbuilt tabs render greyed with a "Soon" pill and unlicensed modules render LOCKED.
// The group scrolls horizontally when it overflows.
const modtab =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-2.5 py-1 text-[12px] tracking-[.3px] text-nb-blueb";
const segBox = "flex shrink-0 gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]";
const segBase =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition";

export default function SectionTabs({ tabs, label, icon }) {
  const pathname = usePathname();
  const { can, user, hasModule } = useAuth();

  // Visibility is by PERMISSION (+ vendor-only super-admin tabs). Module licensing does
  // NOT hide a tab — an unlicensed module renders LOCKED (greyed + lock + "access denied"
  // toast on click) so operators can see what their plan could unlock.
  const visible = tabs.filter(
    (t) =>
      t.disabled ||
      ((!t.superadmin || !!user?.is_superadmin) && (!t.perm || can(t.perm))),
  );

  return (
    <div className="nav-scroll flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {label && (
        <div className={modtab}>
          {icon && <Icon icon={icon} className="text-[14px]" />}
          {label}
        </div>
      )}
      <nav className={segBox}>
        {visible.map((t) => {
          if (t.disabled) {
            return (
              <span
                key={t.title}
                title="Coming soon"
                aria-disabled="true"
                className={`${segBase} cursor-not-allowed select-none border border-transparent text-nb-faint`}
              >
                <Icon icon={t.icon} className="text-[14px]" />
                {t.title}
                <span className="rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-[rgba(150,180,245,.1)] text-nb-faint">
                  Soon
                </span>
              </span>
            );
          }
          if (t.module && !hasModule(t.module)) {
            return (
              <button
                key={t.title}
                type="button"
                title="Not enabled for your organization"
                onClick={() =>
                  toast.error(`Access denied — “${t.title}” isn't enabled for your organization`)
                }
                className={`${segBase} cursor-not-allowed select-none border border-transparent text-nb-faint`}
              >
                <Icon icon={t.icon} className="text-[14px]" />
                {t.title}
                <Icon icon="heroicons-outline:lock-closed" className="text-[12px]" />
              </button>
            );
          }
          const active = pathname === t.link || pathname.startsWith(`${t.link}/`);
          return (
            <Link
              key={t.title}
              href={t.link}
              className={`${segBase} ${
                active
                  ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
                  : "border border-transparent text-nb-faint hover:text-nb-muted"
              }`}
            >
              <Icon icon={t.icon} className="text-[14px]" />
              {t.title}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
