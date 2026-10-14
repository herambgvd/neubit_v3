"use client";

// A single role card in the left library (matches the Users list style): role icon,
// name + System pill, description sub-line, and a user-count dot on the right.
import { Icon } from "@iconify/react";
import type { RoleOut } from "../../types";

export interface RoleListItemProps {
  role: RoleOut;
  selected: boolean;
  onSelect: () => void;
}

export default function RoleListItem({ role, selected, onSelect }: Readonly<RoleListItemProps>) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition ${
        selected
          ? "border-nb-blue/60 bg-nb-blue/10"
          : "border-nb-line bg-nb-surface3/50 hover:border-nb-mist/42"
      }`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] border border-nb-line bg-nb-surface/60 text-nb-blueb">
        <Icon
          icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
          className="text-base"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-nb-ink">{role.name}</span>
          {role.is_system && (
            <span className="rounded-full border border-nb-blue/40 bg-nb-blue/12 px-1.5 py-px text-[9px] font-medium text-nb-blueb">
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
