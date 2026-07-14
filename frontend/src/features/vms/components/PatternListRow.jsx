"use client";

// PatternListRow — one row in the Patterns / Camera-Groups master list. Renders
// an icon (grid for patterns, video-camera for groups), name, a compact meta
// line, an active dot, and hover actions (toggle active / edit / delete).
import { Icon } from "@iconify/react";

import { getGroupLayout } from "../videoWall";

export default function PatternListRow({
  item,
  isPattern,
  isSelected,
  onSelect,
  onToggleActive,
  onEdit,
  onDelete,
}) {
  const active = item.is_active !== false;
  const icon = isPattern ? "heroicons:squares-2x2" : "heroicons-outline:video-camera";
  const meta = isPattern
    ? `${item.seconds || 0}s · ${(item.camera_group_ids || []).length} groups`
    : `${(item.camera_ids || []).length} cameras · ${getGroupLayout(item.layout).label}`;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(item)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(item);
        }
      }}
      className={`group relative flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 outline-none transition ${
        isSelected ? "bg-blue-500/10" : "hover:bg-hover"
      }`}
    >
      {isSelected && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-blue-500" />}
      <div className="relative shrink-0">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-hover text-muted">
          <Icon icon={icon} className="text-base" />
        </span>
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-card ${
            active ? "bg-emerald-500" : "bg-muted"
          }`}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{item.name}</div>
        <div className="truncate text-xs text-muted">{meta}</div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100">
        <RowBtn
          icon={active ? "heroicons-outline:pause-circle" : "heroicons-outline:play-circle"}
          title={active ? "Deactivate" : "Activate"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleActive(item);
          }}
        />
        <RowBtn
          icon="heroicons-outline:pencil-square"
          title="Edit"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(item);
          }}
        />
        <RowBtn
          icon="heroicons-outline:trash"
          title="Delete"
          danger
          onClick={(e) => {
            e.stopPropagation();
            onDelete(item);
          }}
        />
      </div>
    </div>
  );
}

function RowBtn({ icon, title, onClick, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`inline-flex h-7 w-7 items-center justify-center rounded text-muted transition ${
        danger ? "hover:bg-red-500/10 hover:text-red-500" : "hover:bg-hover hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}
