"use client";

// RIGHT column — SECURITY POSTURE context panel (VMS mockup). Real, row-backed
// stats + the recovery actions the mockup places here (clone, force sign-out, and
// unlock when the account is locked). Reset-MFA + status live in the centre editor.
import { Icon } from "@iconify/react";
import { PanelAction as Action, PanelStat as Stat } from "@/components/console";
import type { UserOut } from "../../types";
import { fmtLogin } from "../format";

export interface UserPostureProps {
  user: UserOut;
  canManage: boolean;
  /** Which admin action is in flight (its `key`), or null. */
  busyAction: string | null;
  onClone: () => void;
  onForceSignOut: () => void;
  onUnlock: () => void;
}

export default function UserPosture({ user, canManage, busyAction, onClone, onForceSignOut, onUnlock }: UserPostureProps) {
  const u = user;
  const locked = !!u.locked;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <Icon icon="heroicons-outline:key" className="text-sm text-nb-blueb" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-nb-muted">Security posture</span>
        <span className="ml-auto font-mono text-[10px] text-nb-faint">IS 19319</span>
      </div>

      <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-1">
        <Stat label="MFA" value={u.totp_enabled ? "ENROLLED" : "NOT SET"} tone={u.totp_enabled ? "good" : "warn"} />
        <Stat label="Last sign-in" value={fmtLogin(u.last_login_at)} />
        <Stat
          label="Failed logins"
          value={`${u.failed_login_count ?? 0}${locked ? " · LOCKED" : ""}`}
          tone={locked ? "crit" : u.failed_login_count ? "warn" : "ink"}
        />
        <Stat label="Active sessions" value={u.active_sessions ?? 0} tone={u.active_sessions ? "ink" : "faint"} />
        <Stat label="Created" value={u.created_at ? new Date(u.created_at).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "—"} />
      </div>

      {canManage && (
        <>
          {locked && (
            <Action icon="heroicons-outline:lock-open" tone="good" onClick={onUnlock} busy={busyAction === "unlock"}>
              UNLOCK ACCOUNT ▸
            </Action>
          )}
          <Action icon="heroicons-outline:document-duplicate" tone="blue" onClick={onClone}>
            CLONE THIS USER ▸
          </Action>
          <Action
            icon="heroicons-outline:arrow-right-on-rectangle"
            tone="warn"
            onClick={onForceSignOut}
            disabled={!u.active_sessions}
            busy={busyAction === "revoke"}
          >
            FORCE SIGN-OUT{u.active_sessions ? ` (${u.active_sessions})` : ""} ▸
          </Action>
        </>
      )}

    </div>
  );
}
