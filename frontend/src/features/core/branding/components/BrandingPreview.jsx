"use client";

// Right column of the Branding page: a live mini app-bar preview reflecting the
// current form values (colors, name, logo). Presentational.
import { Icon } from "@iconify/react";

import { Card } from "@/components/ui/kit";

export default function BrandingPreview({ form, logoUrl }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted mb-2">
        Live preview
      </p>
      <Card className="overflow-hidden">
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
              <Icon icon="heroicons-outline:sparkles" className="text-lg text-foreground" />
            )}
          </div>
          <span className="font-semibold text-foreground truncate">
            {form.app_name || "Your App"}
          </span>
          <span
            className="ml-auto rounded-full px-2.5 py-0.5 text-xs font-medium text-foreground"
            style={{ backgroundColor: form.accent_color }}
          >
            Live
          </span>
        </div>
        <div className="p-4 space-y-3">
          <div className="h-2.5 w-3/4 rounded-full bg-hover bg-hover" />
          <div className="h-2.5 w-1/2 rounded-full bg-hover bg-hover" />
          <div className="flex gap-2 pt-2">
            <span
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-foreground"
              style={{ backgroundColor: form.primary_color }}
            >
              Primary
            </span>
            <span
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-foreground"
              style={{ backgroundColor: form.accent_color }}
            >
              Accent
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
