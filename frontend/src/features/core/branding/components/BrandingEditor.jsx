"use client";

// Left column of the Branding page: app-name input, header-name toggle, primary
// + accent color fields, and the logo upload card. Presentational — the parent
// owns the form state and the upload mutation.
import { useRef } from "react";
import { Icon } from "@iconify/react";

import { QuietButton, SectionCard, SectionHead } from "@/components/console";
import { Input, Toggle } from "@/components/ui/kit";
import ColorField from "./ColorField";

export default function BrandingEditor({ form, setForm, logoUrl, onUploadLogo, uploading }) {
  const fileRef = useRef(null);

  function onPickLogo(e) {
    const file = e.target.files?.[0];
    if (file) onUploadLogo(file);
    e.target.value = ""; // allow re-selecting the same file
  }

  return (
    <div className="space-y-3 lg:col-span-2">
      <SectionCard className="space-y-4">
        <SectionHead icon="heroicons-outline:swatch" title="Identity" />
        <Input
          label="App name"
          value={form.app_name}
          onChange={(e) => setForm({ ...form, app_name: e.target.value })}
          placeholder="Neubit"
          hint="Always used for the browser tab title."
        />

        <div className="flex items-center justify-between rounded-[10px] border border-nb-line px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-nb-ink">Show app name in header</div>
            <div className="text-xs text-nb-muted">
              Replace the default mark with your app name. A custom logo overrides this.
            </div>
          </div>
          <Toggle
            checked={form.name_in_header}
            onChange={(v) => setForm({ ...form, name_in_header: v })}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <ColorField
            label="Primary color"
            value={form.primary_color}
            onChange={(v) => setForm({ ...form, primary_color: v })}
          />
          <ColorField
            label="Accent color"
            value={form.accent_color}
            onChange={(v) => setForm({ ...form, accent_color: v })}
          />
        </div>
      </SectionCard>

      <SectionCard>
        <SectionHead
          icon="heroicons-outline:photo"
          title="Logo"
          desc="PNG or SVG works best. Uploads apply immediately."
        />
        <div className="flex items-center gap-4">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-[10px] border border-nb-line bg-white/5">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <Icon icon="heroicons-outline:photo" className="text-3xl text-nb-faint" />
            )}
          </div>
          <div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={onPickLogo}
              className="hidden"
            />
            <QuietButton
              icon="heroicons-outline:arrow-up-tray"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload logo"}
            </QuietButton>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
