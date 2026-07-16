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
          selected ? "bg-hover" : "hover:bg-hover"
        }`}
      >
        {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500" />}
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-500 shrink-0 border border-card-border">
          <Icon
            icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
            className="text-base"
          />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">{role.name}</span>
            {role.is_system && (
              <span className="text-[10px] rounded-full bg-indigo-500/10 text-indigo-500 px-1.5 py-0.5 font-medium">
                System
              </span>
            )}
          </span>
          {role.description && <span className="block text-xs text-muted truncate">{role.description}</span>}
          <span className="block text-[10px] text-muted/70">{permLabel(role)}</span>
        </span>
      </button>
    </li>
  );
}
