"use client";

// Shared card frame for the Security admin sections (policy / directory / SSO).
// Header (icon + title + desc + optional action) over a spinner/error/children body.
// Built on the shared console SectionCard so it carries the same radius, padding
// and uppercase micro-heading as every other Configurations surface.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";

export default function SecuritySection({ title, desc, icon, action, loading, error, children }: any) {
  return (
    <SectionCard>
      <SectionHead icon={icon} title={title} desc={desc} action={action} />

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-nb-muted">
          <Icon icon="svg-spinners:180-ring" className="text-base text-nb-blueb" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-[10px] border border-nb-crit/30 bg-nb-crit/10 px-3 py-3 text-sm text-nb-crit">{error}</div>
      ) : (
        children
      )}
    </SectionCard>
  );
}
