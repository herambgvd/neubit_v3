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
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 text-sm text-foreground">{children}</div>
    </div>
  );
}

export default function UserDetail({ user, canManage, isSelf, onClose, onEdit, onDelete }) {
  const u = user;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <Avatar src={u.avatar_url} name={u.full_name || u.email} size={48} />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{u.full_name || u.email}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              <span className="truncate">{u.email}</span>
              {u.role?.name && (
                <span className="rounded-full bg-blue-500/10 text-blue-500 px-2 py-0.5 font-medium">{u.role.name}</span>
              )}
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  u.is_active ? "bg-green-500/10 text-green-500" : "bg-hover text-muted"
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
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-base" />
          </button>
          {canManage && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
            >
              <Icon icon="heroicons-outline:pencil-square" className="text-sm" /> Edit
            </button>
          )}
          {canManage && !isSelf && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20"
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
