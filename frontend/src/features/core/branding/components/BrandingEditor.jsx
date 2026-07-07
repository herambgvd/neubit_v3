"use client";

// Left column of the Branding page: app-name input, header-name toggle, primary
// + accent color fields, and the logo upload card. Presentational — the parent
// owns the form state and the upload mutation.
import { useRef } from "react";
import { Icon } from "@iconify/react";

import { Button, Card, Input, Toggle } from "@/components/ui/kit";
import ColorField from "./ColorField";

export default function BrandingEditor({ form, setForm, logoUrl, onUploadLogo, uploading }) {
  const fileRef = useRef(null);

  function onPickLogo(e) {
    const file = e.target.files?.[0];
    if (file) onUploadLogo(file);
    e.target.value = ""; // allow re-selecting the same file
  }

  return (
    <div className="lg:col-span-2 space-y-6">
      <Card className="p-6 space-y-5">
        <Input
          label="App name"
          value={form.app_name}
          onChange={(e) => setForm({ ...form, app_name: e.target.value })}
          placeholder="Neubit"
          hint="Always used for the browser tab title."
        />

        <div className="flex items-center justify-between rounded-lg border border-card-border px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-foreground">Show app name in header</div>
            <div className="text-xs text-muted">
              Replace the default mark with your app name. A custom logo overrides this.
            </div>
          </div>
          <Toggle
            checked={form.name_in_header}
            onChange={(v) => setForm({ ...form, name_in_header: v })}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
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
      </Card>

      <Card className="p-6">
        <h3 className="text-base font-semibold text-foreground mb-1">Logo</h3>
        <p className="text-sm text-muted mb-4">
          PNG or SVG works best. Uploads apply immediately.
        </p>
        <div className="flex items-center gap-5">
          <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl border border-card-border border-card-border bg-hover bg-hover">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <Icon
                icon="heroicons-outline:photo"
                className="text-3xl text-muted text-muted"
              />
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
            <Button
              variant="secondary"
              icon="heroicons-outline:arrow-up-tray"
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? "Uploading…" : "Upload logo"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
