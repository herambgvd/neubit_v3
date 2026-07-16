"use client";

// Per-tenant entitlements — the license/plan/modules/limits the super-admin has
// granted THIS tenant, resolved from GET /features (via the auth context). This is
// the multi-tenant view; the signed-license panel below is the platform/on-prem
// license. Super-admins see everything enabled with no limits.
import { Icon } from "@iconify/react";

import { useAuth } from "@/lib/auth";

const STATE_META = {
  active: { tone: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20", label: "Active", icon: "heroicons-outline:check-badge" },
  grace: { tone: "text-amber-500 bg-amber-500/10 border-amber-500/20", label: "Grace period", icon: "heroicons-outline:exclamation-triangle" },
  expired: { tone: "text-red-500 bg-red-500/10 border-red-500/20", label: "Expired", icon: "heroicons-outline:x-circle" },
};

function humanize(key) {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export default function TenantEntitlements() {
  const { entitlements } = useAuth();
  if (!entitlements) return null;

  const { plan, modules = [], limits = {}, license_state, expires_at } = entitlements;
  const state = STATE_META[license_state] || STATE_META.active;
  const enabled = modules.filter((m) => m.enabled);
  const disabled = modules.filter((m) => !m.enabled);
  const limitRows = Object.entries(limits);

  return (
    <div className="rounded-xl border border-card-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Icon icon="heroicons-outline:cube" className="text-accent text-base" />
          Your plan &amp; entitlements
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${state.tone}`}>
          <Icon icon={state.icon} className="text-sm" />
          {state.label}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="text-sm">
          <div className="text-xs text-muted">Plan</div>
          <div className="text-foreground">{plan || "—"}</div>
        </div>
        <div className="text-sm">
          <div className="text-xs text-muted">Expires</div>
          <div className="text-foreground">
            {expires_at ? new Date(expires_at).toLocaleDateString() : "Perpetual"}
          </div>
        </div>
      </div>

      {/* Modules the tenant has access to. */}
      <div className="mt-5">
        <div className="mb-2 text-xs font-medium text-muted">Modules</div>
        <div className="flex flex-wrap gap-2">
          {enabled.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-500">
              <Icon icon="heroicons-outline:check" className="text-sm" />
              {m.name}
            </span>
          ))}
          {disabled.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1.5 rounded-md border border-card-border px-2 py-1 text-xs text-muted/60">
              {m.name}
            </span>
          ))}
          {modules.length === 0 && <span className="text-xs text-muted">No modules in the catalog.</span>}
        </div>
      </div>

      {/* Quotas / limits. */}
      {limitRows.length > 0 && (
        <div className="mt-5">
          <div className="mb-2 text-xs font-medium text-muted">Quotas</div>
          <div className="divide-y divide-card-border rounded-lg border border-card-border">
            {limitRows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-muted">{humanize(k)}</span>
                <span className="font-medium text-foreground">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
