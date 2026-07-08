"use client";

// Floating bulk-action bar shown when ≥1 camera is selected. Drives
// POST /vms/cameras/bulk (enable | disable | group | retention | delete, cap 200).
// Group + retention open a tiny inline picker before firing.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";

export default function BulkActionBar({ count, groups = [], onAction, onClear, pending }) {
  const [mode, setMode] = useState(null); // group | retention
  const [groupId, setGroupId] = useState("");
  const [retention, setRetention] = useState(30);

  if (!count) return null;

  return (
    <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-card-border bg-card px-3 py-2 shadow-2xl">
      <span className="inline-flex items-center gap-1.5 rounded-lg bg-hover px-2.5 py-1 text-xs font-medium text-foreground">
        <Icon icon="heroicons-outline:check-circle" className="text-sm" /> {count} selected
      </span>

      {mode === "group" ? (
        <div className="flex items-center gap-1.5">
          <Select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            options={[{ value: "", label: "Choose group…" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
            className="!h-8 !py-1 w-40"
          />
          <Button variant="primary" className="!px-2.5 !py-1.5 !text-xs" disabled={!groupId || pending} onClick={() => onAction({ action: "group", group_id: groupId })}>
            Apply
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={() => setMode(null)}>Cancel</Button>
        </div>
      ) : mode === "retention" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            className="h-8 w-24 rounded-md border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted"
            placeholder="days"
          />
          <span className="text-xs text-muted">days</span>
          <Button variant="primary" className="!px-2.5 !py-1.5 !text-xs" disabled={pending} onClick={() => onAction({ action: "retention", retention_days: Number(retention) })}>
            Apply
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={() => setMode(null)}>Cancel</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" icon="heroicons-outline:play" className="!px-2.5 !py-1.5 !text-xs" disabled={pending} onClick={() => onAction({ action: "enable" })}>
            Enable
          </Button>
          <Button variant="ghost" icon="heroicons-outline:pause" className="!px-2.5 !py-1.5 !text-xs" disabled={pending} onClick={() => onAction({ action: "disable" })}>
            Disable
          </Button>
          <Button variant="ghost" icon="heroicons-outline:rectangle-group" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setMode("group")}>
            Group
          </Button>
          <Button variant="ghost" icon="heroicons-outline:clock" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setMode("retention")}>
            Retention
          </Button>
          <Button variant="ghost" icon="heroicons-outline:trash" className="!px-2.5 !py-1.5 !text-xs !text-red-500" disabled={pending} onClick={() => onAction({ action: "delete" })}>
            Delete
          </Button>
        </div>
      )}

      <button type="button" onClick={onClear} className="ml-1 rounded p-1 text-muted hover:bg-hover hover:text-foreground" title="Clear selection">
        <Icon icon="heroicons-outline:x-mark" className="text-sm" />
      </button>
    </div>
  );
}
