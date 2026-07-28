"use client";

// RIGHT column — SECURITY POSTURE context panel (VMS mockup). Real, row-backed
// stats + the recovery actions the mockup places here (clone, force sign-out, and
// unlock when the account is locked). Reset-MFA + status live in the centre editor.
import { Icon } from "@iconify/react";
import { fmtLogin } from "../format";

function Stat({ label, value, tone = "ink" }) {
  const c = {
    ink: "text-nb-ink",
    good: "text-nb-good",
    warn: "text-nb-warn",
    crit: "text-nb-crit",
    faint: "text-nb-faint",
  }[tone];
  return (
    <div className="flex items-center justify-between border-b border-nb-line/40 py-2 last:border-b-0">
      <span className="text-[11.5px] text-nb-faint">{label}</span>
      <span className={`font-mono text-[11.5px] ${c}`}>{value}</span>
    </div>
  );
}

function Action({ icon, children, onClick, tone = "blue", disabled, busy }) {
  const cls = {
    blue: "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb hover:bg-[rgba(96,165,250,.16)]",
    warn: "border-[rgba(251,146,60,.5)] bg-[rgba(251,146,60,.1)] text-[#fb923c] hover:bg-[rgba(251,146,60,.16)]",
    good: "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good hover:bg-[rgba(52,211,153,.16)]",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border px-3 py-2 text-[11.5px] tracking-[.5px] transition disabled:opacity-50 ${cls}`}
    >
      <Icon icon={busy ? "svg-spinners:180-ring" : icon} className="text-[13px]" />
      {children}
    </button>
  );
}

export default function UserPosture({ user, canManage, busyAction, onClone, onForceSignOut, onUnlock }) {
  const u = user;
  const locked = !!u.locked;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <div className="mb-2 flex items-center gap-2">
        <Icon icon="heroicons-outline:key" className="text-sm text-nb-blueb" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-nb-muted">Security posture</span>
        <span className="ml-auto font-mono text-[10px] text-nb-faint">IS 19319</span>
      </div>

      <div className="rounded-[11px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-1">
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
