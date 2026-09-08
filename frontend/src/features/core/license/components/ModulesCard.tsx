"use client";

// Modules — ONE list, from two sources.
//
// The page used to print modules twice: the tenant's catalog (with on/off) and
// the signed licence's own list (bare chips). Same word, two lists, different
// contents — and no clue which one governs what you can open. Here the catalog
// is the list, and a module the platform licence also names is marked, so the
// difference is visible in one place instead of being two lists to reconcile.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";
import { useAuth } from "@/lib/auth";

export interface ModulesCardProps {
  /** `modules` from the signed platform license. */
  licenseModules: string[];
}

export default function ModulesCard({ licenseModules }: ModulesCardProps) {
  const { entitlements } = useAuth();
  const catalog = entitlements?.modules || [];
  const licensed = new Set(licenseModules);

  // No catalog (a super-admin with no tenant) → show the licence's own list, or
  // the page would claim there are no modules while the licence names six.
  const rows = catalog.length
    ? catalog.map((m) => ({ key: m.key, name: m.name, enabled: m.enabled, inLicense: licensed.has(m.key) }))
    : licenseModules.map((k) => ({ key: k, name: k, enabled: true, inLicense: true }));

  return (
    <SectionCard>
      <SectionHead
        icon="heroicons-outline:cube"
        title="Modules"
        desc="What this tenant can open. A dot marks a module the platform license also carries."
      />
      {rows.length === 0 ? (
        <p className="text-sm text-nb-muted">No modules in the catalog.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((m) => (
            <li key={m.key} className="flex items-center gap-2 text-[13px]">
              <Icon
                icon={m.enabled ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
                className={`shrink-0 text-base ${m.enabled ? "text-nb-good" : "text-nb-faint"}`}
              />
              <span className={m.enabled ? "text-nb-ink" : "text-nb-faint"}>{m.name}</span>
              {m.inLicense && (
                <span
                  className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-nb-teal shadow-[0_0_5px_#22d3ee]"
                  title="Named by the platform license"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
