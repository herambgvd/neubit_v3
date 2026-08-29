"use client";

// CENTRE column — read-only role detail: header (icon, name, type/permission-count
// pills + Edit/Delete) and a read-only body — description plus the granted
// permissions grouped by catalog category. System roles are view-only (Edit becomes
// "View", Delete hidden). Header actions mirror UserDetail's.
import { Icon } from "@iconify/react";
import { PaneAction, PaneDeleteAction } from "@/components/console";
import { EmptyState } from "@/components/ui/kit";

export default function RoleDetail({ role, groups, catalogLoading, canManage, onEdit, onDelete }: any) {
  const granted = new Set<any>(role.permissions || []);
  const all = granted.has("*");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <header className="flex items-start justify-between gap-4 px-6 py-3.5 border-b border-nb-line">
        <div className="flex items-start gap-3 min-w-0">
          <span className="inline-flex h-12 w-12 items-center justify-center rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-blueb shrink-0">
            <Icon
              icon={role.is_system ? "heroicons-outline:lock-closed" : "heroicons-outline:shield-check"}
              className="text-2xl"
            />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-nb-ink truncate">{role.name}</h2>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-nb-soft flex-wrap">
              <span
                className={`rounded-full px-2 py-0.5 font-medium border ${
                  role.is_system
                    ? "border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] text-nb-blueb"
                    : "border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint"
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
        {/* Same header actions as UserDetail: a labelled Edit, then Delete as the
            red icon-only chip. (The × that used to sit here was dead — clearing the
            selection just re-selected the first role on the next render.) */}
        <div className="flex items-center gap-2 shrink-0">
          {canManage && (
            <PaneAction
              icon={role.is_system ? "heroicons-outline:eye" : "heroicons-outline:pencil-square"}
              onClick={onEdit}
            >
              {role.is_system ? "View" : "Edit"}
            </PaneAction>
          )}
          {canManage && !role.is_system && <PaneDeleteAction title="Delete role" onClick={onDelete} />}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-faint">Description</div>
          <p className="mt-1 text-sm text-nb-ink">{role.description || "—"}</p>
        </div>

        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-faint mb-2">Permissions</div>
          {all ? (
            <div className="flex items-center gap-2 rounded-[10px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.12)] px-3 py-2 text-sm text-nb-blueb">
              <Icon icon="heroicons-outline:check-badge" className="text-base" /> This role grants all permissions.
            </div>
          ) : catalogLoading ? (
            <div className="text-xs text-nb-soft">Loading…</div>
          ) : granted.size === 0 ? (
            <EmptyState title="No permissions" subtitle="This role has no permissions assigned." />
          ) : (
            <div className="space-y-3">
              {Object.entries<any>(groups).map(([category, perms]) => {
                const chosen = perms.filter((p) => granted.has(p.key));
                if (chosen.length === 0) return null;
                return (
                  <div key={category} className="rounded-[12px] border border-nb-line overflow-hidden">
                    <div className="flex items-center justify-between bg-[rgba(96,165,250,.08)] px-4 py-2.5">
                      <span className="text-sm font-semibold text-nb-ink">{category}</span>
                      <span className="text-xs font-mono text-nb-faint">
                        {chosen.length}/{perms.length}
                      </span>
                    </div>
                    <div className="divide-y divide-nb-line/60">
                      {chosen.map((p) => (
                        <div key={p.key} className="flex items-start gap-3 px-4 py-2.5">
                          <Icon icon="heroicons-outline:check-circle" className="mt-0.5 text-base text-nb-good shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm text-nb-ink">{p.label}</div>
                            {p.description && <div className="text-xs text-nb-soft mt-0.5">{p.description}</div>}
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
