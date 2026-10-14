"use client";

// A single user card in the left library (VMS mockup .rl): avatar with initials,
// name + role sub-line, and a status dot (active/locked/disabled) on the right.
import { Avatar } from "@/components/ui/kit";
import type { UserOut } from "../../types";
import { accountStatus, type AccountStatus } from "../format";

const STATUS_DOT: Record<AccountStatus, string> = {
  locked: "bg-nb-crit shadow-[0_0_5px_rgb(var(--nb-c-crit))]",
  active: "bg-nb-good shadow-[0_0_5px_rgb(var(--nb-c-good))]",
  disabled: "bg-nb-faint",
};

export interface UserListItemProps {
  user: UserOut;
  selected: boolean;
  onSelect: () => void;
}

export default function UserListItem({ user, selected, onSelect }: Readonly<UserListItemProps>) {
  const u = user;
  const dot = STATUS_DOT[accountStatus(u)];
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-blue/60 bg-nb-blue/10"
          : "border-nb-line bg-nb-surface3/50 hover:border-nb-mist/42"
      }`}
    >
      <Avatar src={u.avatar_url} name={u.full_name || u.email} size={34} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-nb-ink">
          {u.full_name || u.email}
        </span>
        <span className="block truncate font-mono text-[10px] text-nb-faint">
          {u.role?.name || u.email}
        </span>
      </span>
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
    </button>
  );
}
