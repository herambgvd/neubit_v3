"use client";

// Right-pane detail for a selected user: header (avatar, name, email, role/status
// pills + close/edit/delete), an identity grid, an ACCOUNT SECURITY posture panel
// (real, row-backed), and admin recovery actions (lock/unlock, force sign-out,
// reset MFA, clone) wired to the backend. Mirrors the VMS Users & Roles mockup.
import { Icon } from "@iconify/react";
import { Avatar, Badge } from "@/components/ui/kit";
import { fmtLogin } from "../format";

function InfoField({ label, children }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-faint">{label}</div>
      <div className="mt-1 text-sm text-nb-ink">{children}</div>
    </div>
  );
}

function SectionHeading({ icon, children, note }) {
  return (
    <div className="mb-3 mt-6 flex items-center gap-2 first:mt-0">
      <Icon icon={icon} className="text-sm text-nb-blueb" />
      <span className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{children}</span>
      <span className="h-px flex-1 bg-nb-line/60" />
      {note && <span className="font-mono text-[10px] text-nb-faint">{note}</span>}
    </div>
  );
}

// One security-posture stat: label + a colored value.
function PostureRow({ label, value, tone = "ink" }) {
  const color = {
    ink: "text-nb-ink",
    good: "text-nb-good",
    warn: "text-nb-warn",
    crit: "text-nb-crit",
    faint: "text-nb-faint",
  }[tone];
  return (
    <div className="flex items-center justify-between border-b border-nb-line/40 py-2 last:border-b-0">
      <span className="text-xs text-nb-faint">{label}</span>
      <span className={`font-mono text-[12.5px] ${color}`}>{value}</span>
    </div>
  );
}

function ActionBtn({ icon, children, onClick, tone = "blue", disabled, busy }) {
  const styles = {
    blue: "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb hover:bg-[rgba(96,165,250,.16)]",
    warn: "border-[rgba(251,146,60,.5)] bg-[rgba(251,146,60,.1)] text-[#fb923c] hover:bg-[rgba(251,146,60,.16)]",
    good: "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good hover:bg-[rgba(52,211,153,.16)]",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`inline-flex items-center gap-1.5 rounded-[8px] border px-3 py-1.5 text-xs tracking-[.3px] transition disabled:opacity-50 ${styles}`}
    >
      <Icon icon={busy ? "svg-spinners:180-ring" : icon} className="text-sm" />
      {children}
    </button>
  );
}

function daysSince(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export default function UserDetail({
  user,
  canManage,
  isSelf,
  siteNames = [],
  busyAction,
  onClose,
  onEdit,
  onDelete,
  onLock,
  onUnlock,
  onForceSignOut,
  onResetMfa,
  onClone,
}) {
  const u = user;
  const locked = !!u.locked;
  const pwAge = daysSince(u.password_changed_at);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <Avatar src={u.avatar_url} name={u.full_name || u.email} size={48} />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{u.full_name || u.email}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              <span className="truncate">{u.email}</span>
              {u.role?.name && (
                <span className="rounded-full border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb px-2 py-0.5 font-medium">{u.role.name}</span>
              )}
              {locked ? (
                <span className="rounded-full px-2 py-0.5 font-medium border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] text-nb-crit">Locked</span>
              ) : (
                <span
                  className={`rounded-full px-2 py-0.5 font-medium border ${
                    u.is_active
                      ? "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good"
                      : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"
                  }`}
                >
                  {u.is_active ? "Active" : "Disabled"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onClose}
            title="Close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          {canManage && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] px-2.5 py-1.5 text-xs text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
            >
              <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
            </button>
          )}
          {canManage && !isSelf && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-[8px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.1)] px-2.5 py-1.5 text-xs text-nb-crit transition hover:bg-[rgba(248,113,113,.18)]"
            >
              <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        {/* Identity */}
        <SectionHeading icon="heroicons-outline:user">Identity</SectionHeading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <InfoField label="Full name">{u.full_name || "—"}</InfoField>
          <InfoField label="Email · sign-in">{u.email}</InfoField>
          <InfoField label="Role">{u.role?.name || "—"}</InfoField>
          <InfoField label="Email verified">
            <Badge color={u.email_verified ? "green" : "amber"}>{u.email_verified ? "Verified" : "Pending"}</Badge>
          </InfoField>
          <InfoField label="Access scope">
            {siteNames.length === 0 ? (
              <span className="text-nb-soft">All sites</span>
            ) : (
              <span className="flex flex-wrap gap-1.5">
                {siteNames.map((n) => (
                  <span key={n} className="rounded-[7px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] px-2 py-0.5 text-[11px] text-nb-blueb">
                    {n}
                  </span>
                ))}
              </span>
            )}
          </InfoField>
          <InfoField label="Created">
            {u.created_at ? new Date(u.created_at).toLocaleString() : "—"}
          </InfoField>
        </div>

        {/* Account security posture — real, row-backed */}
        <SectionHeading icon="heroicons-outline:shield-check" note="IS 19319">Account security</SectionHeading>
        <div className="rounded-[11px] border border-nb-line bg-[rgba(6,11,26,.5)] px-4 py-1">
          <PostureRow
            label="Multi-factor (MFA)"
            value={u.totp_enabled ? "ENROLLED" : "NOT SET"}
            tone={u.totp_enabled ? "good" : "warn"}
          />
          <PostureRow label="Last sign-in" value={fmtLogin(u.last_login_at)} />
          <PostureRow
            label="Failed logins"
            value={`${u.failed_login_count ?? 0}${locked ? " · LOCKED" : ""}`}
            tone={locked ? "crit" : u.failed_login_count ? "warn" : "ink"}
          />
          <PostureRow
            label="Active sessions"
            value={u.active_sessions ?? 0}
            tone={u.active_sessions ? "ink" : "faint"}
          />
          <PostureRow
            label="Password age"
            value={pwAge == null ? "—" : `${pwAge} day${pwAge === 1 ? "" : "s"}`}
            tone={pwAge != null && pwAge > 90 ? "warn" : "faint"}
          />
        </div>
        <p className="mt-2 text-[11px] leading-snug text-nb-faint">
          Passwords are never handled here — the user sets and resets their own credential through
          the identity provider; NeuBit stores no plaintext.
        </p>

        {/* Admin recovery actions */}
        {canManage && (
          <>
            <SectionHeading icon="heroicons-outline:key">Admin actions</SectionHeading>
            <div className="flex flex-wrap gap-2">
              {locked ? (
                <ActionBtn icon="heroicons-outline:lock-open" tone="good" onClick={onUnlock} busy={busyAction === "unlock"}>
                  Unlock account
                </ActionBtn>
              ) : (
                !isSelf && (
                  <ActionBtn icon="heroicons-outline:lock-closed" tone="warn" onClick={onLock} busy={busyAction === "lock"}>
                    Lock account
                  </ActionBtn>
                )
              )}
              <ActionBtn
                icon="heroicons-outline:arrow-right-on-rectangle"
                tone="warn"
                onClick={onForceSignOut}
                disabled={!u.active_sessions}
                busy={busyAction === "revoke"}
              >
                Force sign-out{u.active_sessions ? ` (${u.active_sessions})` : ""}
              </ActionBtn>
              <ActionBtn
                icon="heroicons-outline:device-phone-mobile"
                tone="warn"
                onClick={onResetMfa}
                disabled={!u.totp_enabled}
                busy={busyAction === "resetmfa"}
              >
                Reset MFA
              </ActionBtn>
              <ActionBtn icon="heroicons-outline:document-duplicate" tone="blue" onClick={onClone} busy={busyAction === "clone"}>
                Clone user
              </ActionBtn>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-nb-faint">
              Clone a similar user to inherit their role, scope and status in one click — new staff
              productive in seconds. Every action here is audit-signed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
