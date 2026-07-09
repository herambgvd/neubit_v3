"use client";

// Shared card frame for the Security admin sections (policy / directory / SSO).
// Header (icon + title + desc + optional action) over a spinner/error/children body.
import { Icon } from "@iconify/react";

export default function SecuritySection({ title, desc, icon, action, loading, error, children }) {
  return (
    <div className="rounded-xl border border-card-border bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        {icon && (
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-card-border bg-hover/40">
            <Icon icon={icon} className="text-lg text-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {desc && <p className="mt-0.5 text-xs text-muted">{desc}</p>}
        </div>
        {action}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-3 text-sm text-red-500">{error}</div>
      ) : (
        children
      )}
    </div>
  );
}
