"use client";

// A single role row in the master list (left pane). Icon, name + System pill,
// description, and a permission-count line. Mirrors SiteListItem.
import { Icon } from "@iconify/react";

const permLabel = (role) => {
  const perms = role.permissions || [];
  if (perms.includes("*")) return "All permissions";
  return `${perms.length} permission${perms.length === 1 ? "" : "s"}`;
};

export default function RoleListItem({ role, selected, onSelect }) {
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
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-blueb shrink-0">
          <Icon
            icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
            className="text-base"
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-nb-ink truncate">{role.name}</span>
            {role.is_system && (
              <span className="text-[10px] rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb px-1.5 py-0.5 font-medium">
                System
              </span>
            )}
          </span>
          {role.description && <span className="block text-xs text-nb-soft truncate">{role.description}</span>}
          <span className="block text-[10px] font-mono text-nb-faint">{permLabel(role)}</span>
        </span>
      </button>
    </li>
  );
}
