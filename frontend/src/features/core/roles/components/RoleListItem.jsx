"use client";

// A single role card in the left library (matches the Users list style): role icon,
// name + System pill, description sub-line, and a user-count dot on the right.
import { Icon } from "@iconify/react";

export default function RoleListItem({ role, selected, onSelect }) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-[rgba(96,165,250,.6)] bg-[rgba(96,165,250,.1)]"
          : "border-nb-line bg-[rgba(6,11,26,.5)] hover:border-[rgba(150,180,245,.42)]"
      }`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-blueb">
        <Icon
          icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
          className="text-base"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-nb-ink">{role.name}</span>
          {role.is_system && (
            <span className="rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-1.5 py-px text-[9px] font-medium text-nb-blueb">
              System
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-nb-faint">
          {role.description || "—"}
        </span>
      </span>
    </button>
  );
}
