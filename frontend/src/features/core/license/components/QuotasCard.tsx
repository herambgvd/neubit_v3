"use client";

// Quotas and feature flags — the numbers and switches the licence carries beyond
// the two headline limits already in the strip.
//
// Both sources land here, each labelled: the tenant's quotas (what this tenant
// may use) and the platform licence's feature flags (what this build may do).
// They are different questions and the page used to answer them in two cards
// with the same styling and no label.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";
import { useAuth } from "@/lib/auth";
import type { LicenseStatus } from "../../types";

function humanize(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export default function QuotasCard({ lic }: { lic: LicenseStatus | undefined }) {
  const { entitlements } = useAuth();
  const quotas = Object.entries(entitlements?.limits || {});
  const features = Object.entries(lic?.features || {});

  return (
    <SectionCard>
      <SectionHead
        icon="heroicons-outline:adjustments-horizontal"
        title="Quotas & features"
        desc="Tenant quotas, then the flags the signed license carries."
      />

      {quotas.length === 0 && features.length === 0 ? (
        <p className="text-sm text-nb-muted">
          No quotas or feature flags — nothing about this deployment is capped.
        </p>
      ) : (
        <div className="space-y-4">
          {quotas.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-faint">
                Tenant quotas
              </p>
              <div className="divide-y divide-nb-line rounded-[10px] border border-nb-line">
                {quotas.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between px-3 py-1.5 text-[13px]">
                    <span className="text-nb-muted">{humanize(k)}</span>
                    <span className="font-mono font-medium text-nb-ink">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {features.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[1.2px] text-nb-faint">
                License features
              </p>
              <ul className="space-y-1.5">
                {features.map(([key, val]) => {
                  const on = Boolean(val);
                  return (
                    <li key={key} className="flex items-center gap-2 text-[13px]">
                      <Icon
                        icon={on ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
                        className={`shrink-0 text-base ${on ? "text-nb-good" : "text-nb-faint"}`}
                      />
                      <span className={on ? "text-nb-ink" : "text-nb-faint"}>{humanize(key)}</span>
                      {typeof val !== "boolean" && (
                        <span className="ml-auto font-mono text-nb-muted">{String(val)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
