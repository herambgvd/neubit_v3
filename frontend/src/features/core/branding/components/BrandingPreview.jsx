"use client";

// Right column of the Branding page: a live mini app-bar preview reflecting the
// current form values (colors, name, logo). Presentational.
import { Icon } from "@iconify/react";

import { SectionCard, SectionHead } from "@/components/console";

export default function BrandingPreview({ form, logoUrl }) {
  return (
    <SectionCard className="!p-0 overflow-hidden">
      <SectionHead icon="heroicons-outline:eye" title="Live preview" className="!mb-0 px-4 pt-4" />
      <div className="mt-3">
        {/* Mini app-bar */}
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ backgroundColor: form.primary_color }}
        >
          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-md bg-white/10">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <Icon icon="heroicons-outline:sparkles" className="text-lg text-nb-ink" />
            )}
          </div>
          <span className="font-semibold text-nb-ink truncate">
            {form.app_name || "Your App"}
          </span>
          <span
            className="ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium text-nb-ink"
            style={{ backgroundColor: form.accent_color }}
          >
            Live
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div className="h-2.5 w-3/4 rounded-full bg-white/10" />
          <div className="h-2.5 w-1/2 rounded-full bg-white/10" />
          <div className="flex gap-2 pt-2">
            <span
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-nb-ink"
              style={{ backgroundColor: form.primary_color }}
            >
              Primary
            </span>
            <span
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-nb-ink"
              style={{ backgroundColor: form.accent_color }}
            >
              Accent
            </span>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
