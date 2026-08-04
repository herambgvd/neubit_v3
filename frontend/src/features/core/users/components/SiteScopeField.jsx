"use client";

// Site access-scope picker: a chip multiselect over the tenant's real sites.
// EMPTY selection = UNRESTRICTED (the user sees every site) — the honest default,
// since the backend treats an empty site_ids list as "all sites". Only real sites
// from GET /sites are offered; nothing is fabricated.
import { Icon } from "@iconify/react";

export default function SiteScopeField({ sites, value, onChange, disabled }) {
  const selected = new Set(value || []);
  const toggle = (id) => {
    if (disabled) return;
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange([...next]);
  };
  const unrestricted = selected.size === 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="text-xs font-medium text-nb-soft">Site access scope</label>
        <span
          className={`rounded-[5px] border px-1.5 py-px font-mono text-[9px] uppercase tracking-[.5px] ${
            unrestricted
              ? "border-[rgba(52,211,153,.4)] bg-[rgba(52,211,153,.08)] text-nb-good"
              : "border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] text-nb-blueb"
          }`}
        >
          {unrestricted ? "All sites" : `${selected.size} site${selected.size > 1 ? "s" : ""}`}
        </span>
      </div>
      {sites.length === 0 ? (
        <div className="rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2 text-xs text-nb-faint">
          No sites yet — the user can see everything until sites exist.
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {sites.map((s) => {
            const on = selected.has(s.site_id);
            return (
              <button
                key={s.site_id}
                type="button"
                onClick={() => toggle(s.site_id)}
                disabled={disabled}
                className={`inline-flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1 text-[11px] tracking-[.3px] transition disabled:opacity-60 ${
                  on
                    ? "border-[rgba(96,165,250,.5)] bg-[rgba(96,165,250,.1)] text-nb-blueb"
                    : "border-nb-line bg-[rgba(10,18,40,.5)] text-nb-muted hover:border-nb-blue"
                }`}
              >
                {on && <Icon icon="heroicons-mini:check" className="text-[12px]" />}
                {s.name}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-nb-faint">
        Leave empty for full access to all sites. Selecting sites confines this user to their
        cameras and site data.
      </p>
    </div>
  );
}
