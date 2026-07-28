"use client";

// The Users & Roles console strip (VMS mockup): a section modtab, a USERS ⇄ ROLES
// segment toggle (navigates between the two routes), the RBAC posture pill, and an
// AUDIT shortcut. Replaces the app's Config sub-tab bar on these minimal-chrome
// screens. The live clock lives in the header status strip, so it's not repeated.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";

function Seg({ active, onClick, icon, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[7px] px-3.5 py-1.5 text-[12px] tracking-[.8px] transition ${
        active
          ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
          : "border border-transparent text-nb-faint hover:text-nb-muted"
      }`}
    >
      <Icon icon={icon} className="text-[15px]" />
      {children}
    </button>
  );
}

export default function UsersRolesStrip({ active }) {
  const router = useRouter();
  const { can } = useAuth();

  return (
    <div className="relative z-10 flex items-center gap-2.5 px-1 pb-3">
      <div className="flex items-center gap-2 rounded-[8px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-3.5 py-1.5 text-[13px] tracking-[.5px] text-nb-blueb">
        <Icon icon="heroicons-outline:users" className="text-[16px]" />
        Users &amp; Roles
      </div>

      <div className="ml-1.5 flex gap-0.5 rounded-[9px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]">
        <Seg active={active === "users"} onClick={() => router.push("/users")} icon="heroicons-outline:user">
          USERS
        </Seg>
        <Seg active={active === "roles"} onClick={() => router.push("/roles")} icon="heroicons-outline:shield-check">
          ROLES
        </Seg>
      </div>

      <span className="flex-1" />

      <span className="hidden items-center gap-1.5 rounded-[14px] border border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.07)] px-3 py-1.5 font-mono text-[11px] text-nb-good md:flex">
        <span className="h-1.5 w-1.5 rounded-full bg-nb-good shadow-[0_0_5px_#34d399]" />
        RBAC · IS 19319 · LEAST-PRIVILEGE
      </span>

      {can("audit.read") && (
        <Link
          href="/audit"
          title="Access change log — who / when / what, audit-signed"
          className="flex items-center gap-1.5 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-3 py-1.5 text-[12px] tracking-[.4px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
        >
          AUDIT
          <Icon icon="heroicons-mini:arrow-right" className="text-[13px]" />
        </Link>
      )}
    </div>
  );
}
