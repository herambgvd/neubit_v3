"use client";

// Right-pane detail for a selected user: header (avatar, name, email, role/status
// pills + close/edit/delete actions) and a read-only info grid. Edit/Delete run
// through the page's modals. Mirrors SiteDetail's shape.
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

export default function UserDetail({ user, canManage, isSelf, onClose, onEdit, onDelete }) {
  const u = user;
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
              <span
                className={`rounded-full px-2 py-0.5 font-medium border ${
                  u.is_active
                    ? "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good"
                    : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"
                }`}
              >
                {u.is_active ? "Active" : "Disabled"}
              </span>
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <InfoField label="Full name">{u.full_name || "—"}</InfoField>
          <InfoField label="Email">{u.email}</InfoField>
          <InfoField label="Role">{u.role?.name || "—"}</InfoField>
          <InfoField label="Status">
            <Badge color={u.is_active ? "green" : "slate"}>{u.is_active ? "Active" : "Disabled"}</Badge>
          </InfoField>
          <InfoField label="Email verified">
            <Badge color={u.email_verified ? "green" : "amber"}>{u.email_verified ? "Verified" : "Pending"}</Badge>
          </InfoField>
          <InfoField label="Last login">{fmtLogin(u.last_login_at)}</InfoField>
          <InfoField label="Created">
            {u.created_at ? new Date(u.created_at).toLocaleString() : "—"}
          </InfoField>
        </div>
      </div>
    </div>
  );
}
