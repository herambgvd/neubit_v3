"use client";

// RIGHT column — SECURITY POSTURE context panel (VMS mockup). Real, row-backed
// stats + the recovery actions the mockup places here (clone, force sign-out, and
// unlock when the account is locked). Reset-MFA + status live in the centre editor.
import { Icon } from "@iconify/react";
import { PanelAction as Action, PanelStat as Stat } from "@/components/console";
import { fmtLogin } from "../format";

export default function UserPosture({ user, canManage, busyAction, onClone, onForceSignOut, onUnlock }: any) {
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

      <div className="mt-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-[11px] leading-relaxed text-nb-faint">
        <b className="text-nb-muted">Passwords are never handled here.</b> The user sets and resets
        their own credential through the identity provider — NeuBit stores no plaintext and issues
        only reset invitations.
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-nb-faint">
        <b className="text-nb-muted">Fast onboarding:</b> clone a similar user to inherit their role,
        scope and security in one click — then just change the name and email. New staff productive
        in seconds.
      </p>
    </div>
  );
}
