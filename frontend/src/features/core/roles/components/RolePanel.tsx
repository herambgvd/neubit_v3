"use client";

// RIGHT column — ROLE SUMMARY context panel (matches the Users posture panel):
// least-privilege stats derived from the live catalog + clone action + notes.
import { Icon } from "@iconify/react";
import { PanelAction as Action, PanelStat as Stat } from "@/components/console";

export default function RolePanel({ role, groups, canManage, onClone }: any) {
  const granted = new Set<any>(role.permissions || []);
  const all = granted.has("*");
  const allPerms = Object.values<any>(groups).flat();
  const totalCaps = allPerms.length;
  const full = all ? totalCaps : allPerms.filter((p) => granted.has(p.key)).length;
  const areas = Object.values<any>(groups).filter((perms) =>
    all ? perms.length : perms.some((p) => granted.has(p.key)),
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3.5">
      <div className="mb-2 flex items-center gap-2">
        <Icon icon="heroicons-outline:shield-check" className="text-sm text-nb-blueb" />
        <span className="text-[10.5px] font-semibold uppercase tracking-[1.4px] text-nb-muted">Role summary</span>
        <span className="ml-auto font-mono text-[10px] text-nb-faint">
          {role.is_system ? "SYSTEM" : "CUSTOM"}
        </span>
      </div>

      <div className="rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-1">
        <Stat label="Capabilities granted" value={all ? "ALL" : `${full} / ${totalCaps}`} tone="good" />
        <Stat label="Areas touched" value={`${areas} / ${Object.keys(groups).length}`} tone="blue" />
        <Stat label="Scope" value={all ? "Full control" : full === 0 ? "None" : "Scoped"} tone="ink" />
      </div>

      {canManage && (
        <Action icon="heroicons-outline:document-duplicate" tone="blue" onClick={onClone}>
          CLONE THIS ROLE ▸
        </Action>
      )}

      <div className="mt-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 text-[11px] leading-relaxed text-nb-faint">
        <b className="text-nb-muted">Least privilege by default:</b> a new role starts empty — you
        grant up, never claw back. Keep broad roles (Admin, Auditor) few.
      </div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-nb-faint">
        <b className="text-nb-muted">IS 19319 evidence:</b> the permission set exports as an RBAC
        control sheet — who-can-do-what, signed and versioned for the certification file.
      </p>
    </div>
  );
}
