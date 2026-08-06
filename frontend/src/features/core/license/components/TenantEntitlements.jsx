"use client";

// Per-tenant entitlements — the license/plan/modules/limits the super-admin has
// granted THIS tenant, resolved from GET /features (via the auth context). This is
// the multi-tenant view; the signed-license panel below is the platform/on-prem
// license. Super-admins see everything enabled with no limits.
import { Icon } from "@iconify/react";

import { SectionCard } from "@/components/console";
import { useAuth } from "@/lib/auth";

const STATE_META = {
  active: { tone: "text-nb-good bg-nb-good/10 border-nb-good/25", label: "Active", icon: "heroicons-outline:check-badge" },
  grace: { tone: "text-nb-warn bg-nb-warn/10 border-nb-warn/25", label: "Grace period", icon: "heroicons-outline:exclamation-triangle" },
  expired: { tone: "text-nb-crit bg-nb-crit/10 border-nb-crit/25", label: "Expired", icon: "heroicons-outline:x-circle" },
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
    <SectionCard>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">
          <Icon icon="heroicons-outline:cube" className="text-sm text-nb-blueb" />
          Your plan &amp; entitlements
        </div>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${state.tone}`}>
          <Icon icon={state.icon} className="text-sm" />
          {state.label}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="text-sm">
          <div className="text-xs text-nb-muted">Plan</div>
          <div className="text-nb-ink">{plan || "—"}</div>
        </div>
        <div className="text-sm">
          <div className="text-xs text-nb-muted">Expires</div>
          <div className="text-nb-ink">
            {expires_at ? new Date(expires_at).toLocaleDateString() : "Perpetual"}
          </div>
        </div>
      </div>

      {/* Modules the tenant has access to. */}
      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-nb-muted">Modules</div>
        <div className="flex flex-wrap gap-2">
          {enabled.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1.5 rounded-md border border-nb-good/25 bg-nb-good/10 px-2 py-1 text-xs text-nb-good">
              <Icon icon="heroicons-outline:check" className="text-sm" />
              {m.name}
            </span>
          ))}
          {disabled.map((m) => (
            <span key={m.key} className="inline-flex items-center gap-1.5 rounded-md border border-nb-line px-2 py-1 text-xs text-nb-faint">
              {m.name}
            </span>
          ))}
          {modules.length === 0 && <span className="text-xs text-nb-muted">No modules in the catalog.</span>}
        </div>
      </div>

      {/* Quotas / limits. */}
      {limitRows.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-nb-muted">Quotas</div>
          <div className="divide-y divide-nb-line rounded-[10px] border border-nb-line">
            {limitRows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-nb-muted">{humanize(k)}</span>
                <span className="font-medium text-nb-ink">{String(v)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
