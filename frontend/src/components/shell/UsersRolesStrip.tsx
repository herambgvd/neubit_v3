"use client";

// The Users & Roles console strip (VMS mockup): a section modtab + a USERS ⇄ ROLES
// segment toggle (navigates between the two routes). Rendered by ConsoleStrip inside
// the global header bar; the AUDIT link sits beside it (see ConsoleStrip).
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";

function Seg({ active, onClick, icon, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-[11.5px] tracking-[.7px] transition ${
        active
          ? "border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.16)] text-nb-blueb"
          : "border border-transparent text-nb-faint hover:text-nb-muted"
      }`}
    >
      <Icon icon={icon} className="text-[14px]" />
      {children}
    </button>
  );
}

export default function UsersRolesStrip({ active }: any) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.15)] px-2.5 py-1 text-[12px] tracking-[.3px] text-nb-blueb">
        <Icon icon="heroicons-outline:users" className="text-[14px]" />
        Users &amp; Roles
      </div>

      <div className="flex gap-0.5 rounded-[8px] border border-nb-line bg-[rgba(8,15,34,.7)] p-[3px]">
        <Seg active={active === "users"} onClick={() => router.push("/users")} icon="heroicons-outline:user">
          USERS
        </Seg>
        <Seg active={active === "roles"} onClick={() => router.push("/roles")} icon="heroicons-outline:shield-check">
          ROLES
        </Seg>
      </div>
    </div>
  );
}
