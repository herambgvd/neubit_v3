"use client";

// RIGHT column — ROLE SUMMARY context panel (matches the Users posture panel):
// least-privilege stats derived from the live catalog + clone action + notes.
import { Icon } from "@iconify/react";

function Stat({ label, value, tone = "ink" }) {
  const c = {
    ink: "text-nb-ink",
    good: "text-nb-good",
    blue: "text-nb-blueb",
    faint: "text-nb-faint",
  }[tone];
  return (
    <div className="flex items-center justify-between border-b border-nb-line/40 py-1.5 last:border-b-0">
      <span className="text-[11.5px] text-nb-faint">{label}</span>
      <span className={`font-mono text-[11.5px] ${c}`}>{value}</span>
    </div>
  );
}

export default function RolePanel({ role, groups, canManage, onClone }) {
  const granted = new Set(role.permissions || []);
  const all = granted.has("*");
  const allPerms = Object.values(groups).flat();
  const totalCaps = allPerms.length;
  const full = all ? totalCaps : allPerms.filter((p) => granted.has(p.key)).length;
  const areas = Object.values(groups).filter((perms) =>
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
        <button
          type="button"
          onClick={onClone}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[8px] border border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] px-3 py-2 text-[11.5px] tracking-[.5px] text-nb-blueb transition hover:bg-[rgba(96,165,250,.16)]"
        >
          <Icon icon="heroicons-outline:document-duplicate" className="text-[13px]" />
          CLONE ROLE ▸
        </button>
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
