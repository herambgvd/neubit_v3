"use client";

// "Site info" tab body — read-only address / contact / metadata grid plus the
// site image sidebar and inline TagPicker. `InfoField` is a small local display
// helper (label + value) — distinct from the shared form `Field`, which is an
// editable control.
import { Icon } from "@iconify/react";
import { fileUrl } from "@/lib/api";
import TagPicker from "@/components/tags/TagPicker";

function InfoField({ label, full, children }: any) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

export default function SiteInfoPanel({ site }: any) {
  const a = site.address || {};
  const fullAddress = [a.street, a.city, a.state, a.zip_code, a.country].filter(Boolean).join(", ");
  return (
    <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-5 gap-6">
      <div className="lg:col-span-3 space-y-4">
        {site.description && (
          <InfoField label="Description" full>
            <p className="text-sm text-nb-muted">{site.description}</p>
          </InfoField>
        )}
        <InfoField label="Tags" full>
          <TagPicker entityType="site" entityId={site.site_id} />
        </InfoField>
        <InfoField label="Address" full>
          <p className="text-sm text-nb-ink">{fullAddress || "—"}</p>
        </InfoField>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          <InfoField label="Street"><p className="text-sm text-nb-ink">{a.street || "—"}</p></InfoField>
          <InfoField label="City"><p className="text-sm text-nb-ink">{a.city || "—"}</p></InfoField>
          <InfoField label="State / region"><p className="text-sm text-nb-ink">{a.state || "—"}</p></InfoField>
          <InfoField label="Zip code"><p className="text-sm text-nb-ink">{a.zip_code || "—"}</p></InfoField>
          <InfoField label="Country"><p className="text-sm text-nb-ink">{a.country || "—"}</p></InfoField>
          <InfoField label="Coordinates">
            <p className="text-sm text-nb-ink">
              {site.coordinates ? `${site.coordinates.latitude}, ${site.coordinates.longitude}` : "—"}
            </p>
          </InfoField>
          <InfoField label="Contact person"><p className="text-sm text-nb-ink">{site.contact_person || "—"}</p></InfoField>
          <InfoField label="Contact phone"><p className="text-sm text-nb-ink">{site.contact_phone || "—"}</p></InfoField>
          <InfoField label="Email"><p className="text-sm text-nb-ink">{site.email_address || "—"}</p></InfoField>
          <InfoField label="Created"><p className="text-sm text-nb-ink">{site.created_at ? new Date(site.created_at).toLocaleString() : "—"}</p></InfoField>
          <InfoField label="Updated"><p className="text-sm text-nb-ink">{site.updated_at ? new Date(site.updated_at).toLocaleString() : "—"}</p></InfoField>
          {typeof site.floor_count === "number" && (
            <InfoField label="Floor count"><p className="text-sm text-nb-ink">{site.floor_count}</p></InfoField>
          )}
        </div>
      </div>

      <div className="lg:col-span-2">
        <div className="sticky top-4 rounded-xl border border-nb-line bg-white/5 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted mb-2">Site image</div>
          {site.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl(site.image_url)} alt={site.name} className="h-64 w-full rounded-lg border border-nb-line object-cover" />
          ) : (
            <div className="h-64 w-full rounded-lg border border-dashed border-nb-line bg-[rgba(8,15,34,.5)] flex flex-col items-center justify-center text-center px-4">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-nb-muted">
                <Icon icon="heroicons-outline:map-pin" className="text-lg text-nb-muted" />
              </span>
              <p className="mt-2 text-sm font-medium text-nb-ink">No site image</p>
              <p className="text-xs text-nb-muted">Upload an image to show a site preview here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
