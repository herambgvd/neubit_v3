"use client";

// The Branding editor: app name, logo, favicon. Nothing else.
//
// The brand-colour pickers and the "show app name in header" toggle used to live
// here. Both are gone: the colours never coloured anything but the swatch beside
// themselves, and identity here is the three things a tenant actually replaces —
// what it is called, the mark in the console, and the icon in the browser tab.
//
// LOGO AND FAVICON ARE SEPARATE IMAGES, not one resized. A favicon is read at 16px
// in a tab strip, where a wordmark that works in a header is a grey smudge.
//
// Presentational — the parent owns the form state and the upload mutations.
import { useRef, type ChangeEvent } from "react";
import { Icon } from "@iconify/react";

import { QuietButton, SectionCard, SectionHead } from "@/components/console";
import { Input } from "@/components/ui/kit";
import type { BrandingForm } from "../../types";

export interface BrandingEditorProps {
  form: BrandingForm;
  setForm: (form: BrandingForm) => void;
  logoUrl: string | null | undefined;
  faviconUrl: string | null | undefined;
  onUploadLogo: (file: File) => void;
  onUploadFavicon: (file: File) => void;
  uploadingLogo: boolean;
  uploadingFavicon: boolean;
}

/** One upload row: a preview box, a hidden file input, and the button. */
function ImageUpload({
  label,
  url,
  alt,
  accept,
  busy,
  onPick,
}: {
  label: string;
  url: string | null | undefined;
  alt: string;
  accept: string;
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onPick(file);
    e.target.value = ""; // so re-selecting the same file still fires a change
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-[10px] border border-nb-line bg-white/5">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={alt} className="h-full w-full object-contain" />
        ) : (
          <Icon icon="heroicons-outline:photo" className="text-3xl text-nb-faint" />
        )}
      </div>
      <div>
        <input ref={ref} type="file" accept={accept} onChange={pick} className="hidden" />
        <QuietButton
          icon="heroicons-outline:arrow-up-tray"
          disabled={busy}
          onClick={() => ref.current?.click()}
        >
          {busy ? "Uploading…" : label}
        </QuietButton>
      </div>
    </div>
  );
}

export default function BrandingEditor({
  form,
  setForm,
  logoUrl,
  faviconUrl,
  onUploadLogo,
  onUploadFavicon,
  uploadingLogo,
  uploadingFavicon,
}: BrandingEditorProps) {
  // A FRAGMENT, not a wrapping column. The three cards are direct children of the
  // page's column flow, so the browser can balance them against the preview
  // instead of stacking them in a fixed two-thirds column with the preview
  // stranded beside a lot of nothing.
  return (
    <>
      <SectionCard className="space-y-4">
        <SectionHead icon="heroicons-outline:identification" title="Identity" />
        <Input
          label="App name"
          value={form.app_name}
          onChange={(e) => setForm({ ...form, app_name: e.target.value })}
          placeholder="Neubit"
          hint="Used for the browser tab title and in outgoing email."
        />
      </SectionCard>

      <SectionCard>
        <SectionHead
          icon="heroicons-outline:photo"
          title="Logo"
          desc="Shown in the console. PNG or SVG works best. Uploads apply immediately."
        />
        <ImageUpload
          label="Upload logo"
          url={logoUrl}
          alt="Logo"
          accept="image/*"
          busy={uploadingLogo}
          onPick={onUploadLogo}
        />
      </SectionCard>

      <SectionCard>
        <SectionHead
          icon="heroicons-outline:globe-alt"
          title="Favicon"
          desc="The browser-tab icon. A square image reads best — it is shown at 16px."
        />
        <ImageUpload
          label="Upload favicon"
          url={faviconUrl}
          alt="Favicon"
          accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon"
          busy={uploadingFavicon}
          onPick={onUploadFavicon}
        />
      </SectionCard>
    </>
  );
}
