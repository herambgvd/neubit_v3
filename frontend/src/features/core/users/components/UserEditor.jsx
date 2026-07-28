"use client";

// CENTER column — inline user editor (VMS mockup). Header (avatar, name, email,
// status badge), IDENTITY (editable name, read-only email, role select, real site
// access-scope chips) and ACCOUNT SECURITY (MFA state, account status segment wired
// to enable/disable/lock, plus real read-only session-timeout + password-age).
// Editable fields are saved together via onSave; status + MFA changes fire their
// dedicated admin actions immediately.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { Avatar } from "@/components/ui/kit";

function Section({ icon, children, note }) {
  return (
    <div className="mb-3 mt-6 flex items-center gap-2 first:mt-0">
      <Icon icon={icon} className="text-sm text-nb-blueb" />
      <span className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-nb-faint">{children}</span>
      <span className="h-px flex-1 bg-nb-line/60" />
      {note && <span className="font-mono text-[10px] text-nb-faint">{note}</span>}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-start gap-4 border-b border-nb-line/40 py-2.5 last:border-b-0">
      <span className="w-[130px] shrink-0 pt-1.5 text-[11.5px] text-nb-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const inputCls =
  "w-full rounded-[7px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-1.5 font-mono text-[12.5px] text-nb-blueb outline-none focus:border-nb-teal";

function daysSince(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

export default function UserEditor({
  user,
  canManage,
  isSelf,
  sites = [],
  sessionIdleMinutes,
  busyAction,
  onSave,
  onDelete,
  onSetStatus, // (status) => void   status: "active" | "disabled" | "locked"
  onResetMfa,
}) {
  const u = user;
  const [fullName, setFullName] = useState(u.full_name || "");
  const [roleId, setRoleId] = useState(u.role?.id || "");
  const [siteIds, setSiteIds] = useState(u.site_ids || []);

  // Reset local edits whenever the selected user changes.
  useEffect(() => {
    setFullName(u.full_name || "");
    setRoleId(u.role?.id || "");
    setSiteIds(u.site_ids || []);
  }, [u.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    fullName !== (u.full_name || "") ||
    JSON.stringify([...siteIds].sort()) !== JSON.stringify([...(u.site_ids || [])].sort());

  const status = u.locked ? "locked" : u.is_active ? "active" : "disabled";
  const pwAge = daysSince(u.password_changed_at);
  const selectedSites = new Set(siteIds);
  const toggleSite = (id) => {
    if (!canManage) return;
    const next = new Set(selectedSites);
    next.has(id) ? next.delete(id) : next.add(id);
    setSiteIds([...next]);
  };

  const statusBtn = (val, label, tone) => {
    const on = status === val;
    const activeCls = {
      active: "bg-[rgba(52,211,153,.18)] text-nb-good",
      disabled: "bg-[rgba(120,140,180,.2)] text-nb-muted",
      locked: "bg-[rgba(248,113,113,.18)] text-nb-crit",
    }[tone];
    return (
      <button
        type="button"
        disabled={!canManage || (val === "locked" && isSelf)}
        onClick={() => onSetStatus(val)}
        className={`px-3 py-1.5 text-[10.5px] tracking-[.5px] transition disabled:opacity-40 ${
          on ? activeCls : "text-nb-faint hover:text-nb-muted"
        }`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-nb-line px-5 py-4">
        <Avatar src={u.avatar_url} name={u.full_name || u.email} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold text-nb-ink">{u.full_name || u.email}</h2>
          <div className="truncate font-mono text-[11px] text-nb-faint">{u.email}</div>
        </div>
        <span
          className={`rounded-[7px] border px-2.5 py-1 text-[10px] tracking-[.5px] ${
            status === "locked"
              ? "border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] text-nb-crit"
              : status === "active"
                ? "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good"
                : "border-nb-line text-nb-faint"
          }`}
        >
          {status.toUpperCase()}
        </span>
        {canManage && !isSelf && (
          <button
            onClick={onDelete}
            title="Delete user"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-[rgba(248,113,113,.4)] bg-[rgba(248,113,113,.1)] text-nb-crit transition hover:bg-[rgba(248,113,113,.18)]"
          >
            <Icon icon="heroicons-outline:trash" className="text-sm" />
          </button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Identity */}
        <Section icon="heroicons-outline:user">Identity</Section>
        <Row label="Full name">
          <input
            className={inputCls}
            value={fullName}
            disabled={!canManage}
            onChange={(e) => setFullName(e.target.value)}
          />
        </Row>
        <Row label="Email · sign-in">
          <input className={`${inputCls} opacity-70`} value={u.email} readOnly />
        </Row>
        <Row label="Role">
          <span className="inline-flex items-center gap-2 rounded-[8px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] px-3 py-1.5 text-[12px] text-nb-blueb">
            <Icon icon="heroicons-outline:shield-check" className="text-[13px]" />
            {u.role?.name || "—"}
          </span>
          <span className="ml-2 text-[11px] text-nb-faint">inherits its permissions</span>
        </Row>
        <Row label="Access scope">
          {sites.length === 0 ? (
            <span className="text-[12px] text-nb-soft">All sites</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {sites.map((s) => {
                const on = selectedSites.has(s.site_id);
                return (
                  <button
                    key={s.site_id}
                    type="button"
                    onClick={() => toggleSite(s.site_id)}
                    disabled={!canManage}
                    className={`rounded-[8px] border px-2.5 py-1 text-[11px] transition disabled:opacity-60 ${
                      on
                        ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb"
                        : "border-nb-line bg-[rgba(10,18,40,.5)] text-nb-muted hover:border-nb-blue"
                    }`}
                  >
                    {s.name}
                  </button>
                );
              })}
              <span className="rounded-[8px] border border-dashed border-nb-line px-2 py-1 text-[10px] text-nb-faint">
                empty = all
              </span>
            </div>
          )}
        </Row>

        {/* Account security */}
        <Section icon="heroicons-outline:shield-check" note="IS 19319">Account security</Section>
        <Row label="Multi-factor (MFA)">
          <div className="flex items-center gap-2.5">
            <span
              className={`inline-flex h-[21px] w-[38px] items-center rounded-full border px-0.5 ${
                u.totp_enabled
                  ? "justify-end border-[rgba(52,211,153,.6)] bg-[rgba(52,211,153,.2)]"
                  : "justify-start border-nb-line bg-[rgba(90,110,150,.15)]"
              } ${canManage && u.totp_enabled ? "cursor-pointer" : "cursor-default"}`}
              onClick={() => canManage && u.totp_enabled && onResetMfa()}
              title={u.totp_enabled ? "Reset (disable) MFA" : "The user enrols MFA from their device"}
            >
              <span className={`h-4 w-4 rounded-full ${u.totp_enabled ? "bg-nb-good" : "bg-nb-faint"}`} />
            </span>
            <span className="text-[11.5px] text-nb-faint">{u.totp_enabled ? "enrolled" : "not enrolled"}</span>
          </div>
        </Row>
        <Row label="Account status">
          <div className="inline-flex overflow-hidden rounded-[7px] border border-nb-line">
            {statusBtn("active", "ACTIVE", "active")}
            <span className="w-px bg-nb-line" />
            {statusBtn("disabled", "DISABLED", "disabled")}
            <span className="w-px bg-nb-line" />
            {statusBtn("locked", "LOCKED", "locked")}
          </div>
        </Row>
        <Row label="Session timeout">
          <span className="font-mono text-[12.5px] text-nb-ink">
            {sessionIdleMinutes ? `${sessionIdleMinutes} min` : "Not set"}
          </span>
          <span className="ml-2 text-[11px] text-nb-faint">tenant policy · idle auto sign-out</span>
        </Row>
        <Row label="Password age">
          <span className="font-mono text-[12.5px] text-nb-ink">
            {pwAge == null ? "—" : `${pwAge} day${pwAge === 1 ? "" : "s"}`}
          </span>
          <span className="ml-2 text-[11px] text-nb-faint">since last change</span>
        </Row>

        {canManage && dirty && (
          <div className="mt-5 flex items-center gap-2">
            <button
              onClick={() => onSave({ full_name: fullName, role_id: roleId, site_ids: siteIds })}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] px-4 py-1.5 text-[12px] font-medium tracking-[.4px] text-nb-good transition hover:bg-[rgba(52,211,153,.16)]"
            >
              <Icon icon={busyAction === "save" ? "svg-spinners:180-ring" : "heroicons-mini:check"} className="text-sm" />
              Save changes
            </button>
            <button
              onClick={() => {
                setFullName(u.full_name || "");
                setSiteIds(u.site_ids || []);
              }}
              className="rounded-[8px] border border-nb-line px-3 py-1.5 text-[12px] text-nb-muted transition hover:text-nb-ink"
            >
              Discard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
