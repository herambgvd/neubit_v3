"use client";

// A single user row in the master list (left pane). Avatar with an active-status
// dot, name + role pill, email. Selection highlight + click handled by the parent
// Users orchestrator. Mirrors SiteListItem.
import { Avatar } from "@/components/ui/kit";

export default function UserListItem({ user, selected, onSelect }) {
  const u = user;
  return (
    <li className="relative">
      <button
        onClick={onSelect}
        className={`w-full flex items-start gap-3 px-4 py-3 text-left transition ${
          selected
            ? "bg-[rgba(96,165,250,.1)]"
            : "hover:bg-[rgba(96,165,250,.06)]"
        }`}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-nb-blue" />}
        <span className="relative shrink-0">
          <Avatar src={u.avatar_url} name={u.full_name || u.email} size={36} />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[#0c1530] ${
              u.is_active ? "bg-nb-good shadow-[0_0_5px_#34d399]" : "bg-nb-faint"
            }`}
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-nb-ink truncate">{u.full_name || u.email}</span>
            {u.role?.name && (
              <span className="text-[10px] rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb px-1.5 py-0.5 font-medium">
                {u.role.name}
              </span>
            )}
          </span>
          <span className="block text-xs text-nb-faint truncate">{u.email}</span>
        </span>
      </button>
    </li>
  );
}
