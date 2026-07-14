"use client";

// Floating bulk-action bar shown when ≥1 camera is selected. Drives
// POST /vms/cameras/bulk (enable | disable | group | retention | delete, cap 200)
// and — for operators with vms.config.manage — the G7 device fleet ops
// (reboot | ntp | password) via POST /vms/cameras/bulk/{action}. Group/retention/
// ntp/password open a tiny inline picker before firing.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Select } from "@/components/ui/kit";

export default function BulkActionBar({
  count,
  groups = [],
  onAction,
  onDeviceAction,
  canManageDevices = false,
  onClear,
  pending,
}) {
  // null | group | retention | device | ntp | password
  const [mode, setMode] = useState(null);
  const [groupId, setGroupId] = useState("");
  const [retention, setRetention] = useState(30);
  const [ntpServer, setNtpServer] = useState("");
  const [pwUser, setPwUser] = useState("");
  const [pwNew, setPwNew] = useState("");

  if (!count) return null;

  const reset = () => setMode(null);
  const inputCls =
    "h-8 rounded-md border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted";

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
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={reset}>Cancel</Button>
        </div>
      ) : mode === "retention" ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            className={`${inputCls} w-24`}
            placeholder="days"
          />
          <span className="text-xs text-muted">days</span>
          <Button variant="primary" className="!px-2.5 !py-1.5 !text-xs" disabled={pending} onClick={() => onAction({ action: "retention", retention_days: Number(retention) })}>
            Apply
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={reset}>Cancel</Button>
        </div>
      ) : mode === "ntp" ? (
        <div className="flex items-center gap-1.5">
          <input
            value={ntpServer}
            onChange={(e) => setNtpServer(e.target.value)}
            className={`${inputCls} w-44`}
            placeholder="NTP server (pool.ntp.org)"
          />
          <Button variant="primary" className="!px-2.5 !py-1.5 !text-xs" disabled={pending || !ntpServer.trim()} onClick={() => onDeviceAction?.({ action: "ntp", server: ntpServer.trim() })}>
            Set NTP
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={reset}>Cancel</Button>
        </div>
      ) : mode === "password" ? (
        <div className="flex items-center gap-1.5">
          <input value={pwUser} onChange={(e) => setPwUser(e.target.value)} className={`${inputCls} w-28`} placeholder="user (opt)" />
          <input value={pwNew} onChange={(e) => setPwNew(e.target.value)} type="password" className={`${inputCls} w-36`} placeholder="new password" />
          <Button variant="primary" className="!px-2.5 !py-1.5 !text-xs" disabled={pending || !pwNew} onClick={() => onDeviceAction?.({ action: "password", user: pwUser.trim() || undefined, new_password: pwNew })}>
            Change
          </Button>
          <Button variant="ghost" className="!px-2 !py-1.5 !text-xs" onClick={reset}>Cancel</Button>
        </div>
      ) : mode === "device" ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" icon="heroicons-outline:arrow-path" className="!px-2.5 !py-1.5 !text-xs !text-red-500" disabled={pending} onClick={() => onDeviceAction?.({ action: "reboot" })}>
            Reboot
          </Button>
          <Button variant="ghost" icon="heroicons-outline:clock" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setMode("ntp")}>
            Set NTP
          </Button>
          <Button variant="ghost" icon="heroicons-outline:key" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setMode("password")}>
            Password
          </Button>
          <Button variant="ghost" icon="heroicons-outline:bolt" className="!px-2.5 !py-1.5 !text-xs" disabled={pending} onClick={() => onDeviceAction?.({ action: "apply-stream-policy" })} title="Force the sub-stream to H.264 for browser-direct playback (main stays H.265 for recording)">
            Web profile
          </Button>
          <Button variant="ghost" icon="heroicons-outline:arrow-uturn-left" className="!px-2 !py-1.5 !text-xs" onClick={reset}>
            Back
          </Button>
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
          {canManageDevices && (
            <Button variant="ghost" icon="heroicons-outline:wrench-screwdriver" className="!px-2.5 !py-1.5 !text-xs" onClick={() => setMode("device")}>
              Device
            </Button>
          )}
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
