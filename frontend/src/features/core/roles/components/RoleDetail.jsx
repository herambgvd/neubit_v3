"use client";

// Right-pane detail for a selected role: header (icon, name, type/permission-count
// pills + close/edit/delete actions) and a read-only body — description plus the
// granted permissions grouped by catalog category. System roles are view-only
// (Edit becomes "View", Delete hidden). Mirrors SiteDetail's shape.
import { Icon } from "@iconify/react";
import { EmptyState } from "@/components/ui/kit";

export default function RoleDetail({ role, groups, catalogLoading, onClose, onEdit, onDelete }) {
  const granted = new Set(role.permissions || []);
  const all = granted.has("*");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-5 border-b border-card-border">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-500 shrink-0">
            <Icon
              icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
              className="text-2xl"
            />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground truncate">{role.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted flex-wrap">
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  role.is_system ? "bg-indigo-500/10 text-indigo-500" : "bg-hover text-muted"
                }`}
              >
                {role.is_system ? "System" : "Custom"}
              </span>
              <span>
                {all ? "All permissions" : `${granted.size} permission${granted.size === 1 ? "" : "s"}`}
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
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1 rounded-md border border-card-border px-2.5 py-1.5 text-xs text-foreground hover:bg-hover"
          >
            <Icon
              icon={role.is_system ? "heroicons-outline:eye" : "heroicons-outline:pencil-square"}
              className="text-sm"
            />{" "}
            {role.is_system ? "View" : "Edit"}
          </button>
          {!role.is_system && (
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-500 hover:bg-red-500/20"
            >
              <Icon icon="heroicons-outline:trash" className="text-sm" /> Delete
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">Description</div>
          <p className="mt-1 text-sm text-foreground">{role.description || "—"}</p>
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">Permissions</div>
          {all ? (
            <div className="flex items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-500">
              <Icon icon="heroicons-outline:check-badge" className="text-base" /> This role grants all permissions.
            </div>
          ) : catalogLoading ? (
            <div className="text-xs text-muted">Loading…</div>
          ) : granted.size === 0 ? (
            <EmptyState title="No permissions" subtitle="This role has no permissions assigned." />
          ) : (
            <div className="space-y-3">
              {Object.entries(groups).map(([category, perms]) => {
                const chosen = perms.filter((p) => granted.has(p.key));
                if (chosen.length === 0) return null;
                return (
                  <div key={category} className="rounded-xl border border-card-border overflow-hidden">
                    <div className="flex items-center justify-between bg-hover px-4 py-2.5">
                      <span className="text-sm font-semibold text-foreground">{category}</span>
                      <span className="text-xs text-muted">
                        {chosen.length}/{perms.length}
                      </span>
                    </div>
                    <div className="divide-y divide-card-border">
                      {chosen.map((p) => (
                        <div key={p.key} className="flex items-start gap-3 px-4 py-2.5">
                          <Icon icon="heroicons-outline:check-circle" className="mt-0.5 text-base text-green-500 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm text-foreground">{p.label}</div>
                            {p.description && <div className="text-xs text-muted mt-0.5">{p.description}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
