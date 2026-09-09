"use client";

// One registration in the left library. Deliberately the same card as
// SiteListItem / UserListItem — bordered button, 9×9 glyph tile, name plus a
// pill, a mono sub-line and a status mark on the right — because this console
// sits beside those and was the odd one out: a borderless hover-row with icon
// actions that appeared only on hover.
//
// The pill is the CATEGORY, which is the one thing about a registration an
// operator scans for: it says which console shows this dashboard.
//
// The right-hand mark is a LOCK, not a status dot. There is no active/inactive
// here, and a grey dot would invent one; what is worth seeing at a glance is
// whether the embed token pins filter values — an unlocked dashboard shows every
// viewer every row it can reach.
import { Icon } from "@iconify/react";

import type { DashForgeEmbed } from "../api";
import { CATEGORIES, categoryLabel } from "../constants";

export interface DashboardListItemProps {
  dashboard: DashForgeEmbed;
  selected: boolean;
  onSelect: () => void;
}

export default function DashboardListItem({ dashboard, selected, onSelect }: DashboardListItemProps) {
  const d = dashboard;
  const icon = CATEGORIES.find((c) => c.slug === d.category)?.icon || "heroicons-outline:squares-2x2";
  const locked = Object.keys(d.scope || {}).length;

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
        <Icon icon={icon} className="text-base" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-nb-ink">{d.name}</span>
          <span className="shrink-0 rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-1.5 py-px text-[9px] font-medium text-nb-blueb">
            {categoryLabel(d.category)}
          </span>
        </span>
        <span className="block truncate font-mono text-[10px] text-nb-faint">{d.dashboard_ref}</span>
      </span>
      {locked > 0 && (
        <Icon
          icon="heroicons-outline:lock-closed"
          title={`${locked} locked filter${locked === 1 ? "" : "s"}`}
          className="shrink-0 text-[13px] text-nb-good"
        />
      )}
    </button>
  );
}
