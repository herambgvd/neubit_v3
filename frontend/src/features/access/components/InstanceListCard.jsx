"use client";

// Left-list row for one onboarded controller. Ported from neubit_v2's
// instance-list-card.jsx: selectable card + kebab menu (Edit / Delete), health
// badge, site name, base URL, last-sync relative time. Rethemed to v3 tokens.
import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";

import { fmtRelative } from "@/lib/format";
import HealthBadge from "./HealthBadge";

export default function InstanceListCard({
  instance,
  siteName,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handler = (e) => {
      if (!ref.current?.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      onClick={() => onSelect(instance)}
      className={`group relative cursor-pointer rounded-lg border transition ${
        isSelected
          ? "border-foreground bg-hover"
          : "border-card-border hover:bg-hover"
      }`}
    >
      {isSelected && <span className="absolute bottom-0 left-0 top-0 w-0.5 rounded-l bg-blue-500" />}

      <div className="flex items-start gap-2">
        <div className="ml-3 mt-2.5 inline-flex h-6 w-6 items-center justify-center rounded bg-hover text-muted">
          <Icon icon="heroicons-outline:server" className="text-sm" />
        </div>
        <div className="min-w-0 flex-1 py-2.5 pr-2">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-semibold text-foreground">{instance.name}</p>
            <HealthBadge status={instance.status} />
          </div>
          <p className="mt-0.5 truncate text-[10px] text-muted">{siteName || "Unassigned site"}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted/70">{instance.base_url}</p>
          {instance.last_sync_at && (
            <p className="mt-0.5 text-[9px] text-muted/70">Last sync · {fmtRelative(instance.last_sync_at)}</p>
          )}
        </div>

        <div className="relative" ref={ref}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            className="rounded p-1 text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:ellipsis-vertical" className="text-sm" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-10 w-32 overflow-hidden rounded-md border border-card-border bg-card shadow-lg">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onEdit?.(instance);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted hover:bg-hover hover:text-foreground"
              >
                <Icon icon="heroicons-outline:pencil-square" className="text-xs" /> Edit
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                  onDelete?.(instance);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-red-500 hover:bg-red-500/10"
              >
                <Icon icon="heroicons-outline:trash" className="text-xs" /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
