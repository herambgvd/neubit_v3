"use client";

// A preview of what the branding actually changes: the tab (favicon + app name)
// and the console's brand mark (logo, or the name when there is no logo).
//
// It used to preview brand COLOURS, which was the only place those colours ever
// appeared — the console itself ignored them. Previewing something nothing else
// renders is worse than showing nothing: it demonstrates an effect the product
// does not have.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";
import type { BrandingForm } from "../../types";

export interface BrandingPreviewProps {
  form: BrandingForm;
  logoUrl?: string | null;
  faviconUrl?: string | null;
}

export default function BrandingPreview({ form, logoUrl, faviconUrl }: BrandingPreviewProps) {
  const name = form.app_name.trim() || "Neubit";

  return (
    // Deliberately the SMALLEST card here. It is a reference for the two uploads,
    // not a feature of its own, and at full height it pushed the cards that do the
    // work down the page.
    <SectionCard className="space-y-3">
      <SectionHead icon="heroicons-outline:eye" title="Live preview" />

      {/* A browser tab: favicon + the app name, which is the title. */}
      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">Browser tab</div>
        <div className="flex w-fit max-w-full items-center gap-2 rounded-t-[10px] border border-nb-line border-b-0 bg-[rgba(255,255,255,.05)] px-3 py-1.5">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded-[3px]">
            {faviconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={faviconUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <Icon icon="heroicons-outline:globe-alt" className="text-[13px] text-nb-faint" />
            )}
          </span>
          <span className="truncate text-[12px] text-nb-ink">{name}</span>
        </div>
      </div>

      {/* The console's brand mark. */}
      <div>
        <div className="mb-1 text-[10.5px] uppercase tracking-[1.2px] text-nb-faint">Console mark</div>
        <div className="flex items-center gap-2.5 rounded-[10px] border border-nb-line bg-[rgba(255,255,255,.03)] px-3 py-2">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={name} className="h-6 max-w-[150px] object-contain" />
          ) : (
            <span className="text-[15px] font-semibold tracking-tight text-nb-ink">{name}</span>
          )}
        </div>
        <p className="mt-1 text-[10.5px] text-nb-faint">
          {logoUrl ? "Your logo, as the console shows it." : "No logo uploaded — the app name is used."}
        </p>
      </div>
    </SectionCard>
  );
}
