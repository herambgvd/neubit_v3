"use client";

// A single user card in the left library (VMS mockup .rl): avatar with initials,
// name + role sub-line, and a status dot (active/locked/disabled) on the right.
import { Avatar } from "@/components/ui/kit";

export default function UserListItem({ user, selected, onSelect }: any) {
  const u = user;
  const dot = u.locked
    ? "bg-nb-crit shadow-[0_0_5px_#f87171]"
    : u.is_active
      ? "bg-nb-good shadow-[0_0_5px_#34d399]"
      : "bg-nb-faint";
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-[rgba(96,165,250,.6)] bg-[rgba(96,165,250,.1)]"
          : "border-nb-line bg-[rgba(6,11,26,.5)] hover:border-[rgba(150,180,245,.42)]"
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
