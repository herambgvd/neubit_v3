"use client";

// Full site create/edit modal — identity, address, coordinates, and contact
// sections plus an image upload/preview. Auto-generates a location code from the
// site type on create. On save, creates/updates then optionally uploads the image.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Overlay } from "@/components/ui/kit";
import { FieldLabel, fieldClass } from "@/components/common";
import { api, apiError, fileUrl } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { SITE_TYPES, THREAT_LEVELS, capitalize, generateLocationCode } from "../constants";
import { FInput, FTextarea, FSelect, ImagePreviewCard, Section } from "./FormControls";
import GeocodeButton from "./GeocodeButton";

export default function SiteFormModal({ site, allSites, onCancel, onSaved }) {
  const isEdit = !!site;
  const [name, setName] = useState(site?.name || "");
  const [locationCode, setLocationCode] = useState(
    site?.location_code || (isEdit ? "" : generateLocationCode(site?.site_type || "building")),
  );
  const [description, setDescription] = useState(site?.description || "");
  const [siteType, setSiteType] = useState(site?.site_type || "building");
  const [parentId, setParentId] = useState(site?.parent_id || "");
  const [threatLevel, setThreatLevel] = useState(site?.threat_level || "normal");
  const [street, setStreet] = useState(site?.address?.street || "");
  const [city, setCity] = useState(site?.address?.city || "");
  const [state, setState] = useState(site?.address?.state || "");
  const [zipCode, setZipCode] = useState(site?.address?.zip_code || "");
  const [country, setCountry] = useState(site?.address?.country || "India");
  const [latitude, setLatitude] = useState(site?.coordinates?.latitude ?? "");
  const [longitude, setLongitude] = useState(site?.coordinates?.longitude ?? "");
  const [contactPerson, setContactPerson] = useState(site?.contact_person || "");
  const [contactPhone, setContactPhone] = useState(site?.contact_phone || "");
  const [emailAddress, setEmailAddress] = useState(site?.email_address || "");
  const [geoMatch, setGeoMatch] = useState("");
  const [errors, setErrors] = useState({});
  const [imageFile, setImageFile] = useState(null);
  const [existingImageUrl] = useState(site?.image_url || "");
  const [selectedPreview, setSelectedPreview] = useState("");
  const previewUrl = selectedPreview || (existingImageUrl ? fileUrl(existingImageUrl) : "");

  useEffect(() => {
    if (!imageFile) {
      setSelectedPreview("");
      return undefined;
    }
    const url = URL.createObjectURL(imageFile);
    setSelectedPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  // Escape-to-close lives in <Overlay>.

  // Address → coordinates is only offered when this tenant has Google Maps turned
  // on AND a key saved; same config the Sites Map reads, so it stays in one place.
  const mapsQ = useQuery({
    queryKey: ["maps-config"],
    queryFn: () => api.get("/settings/maps").then((r) => r.data),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const mapsKey = (mapsQ.data?.enabled && mapsQ.data?.api_key) || "";

  const saving = useMutation({
    mutationFn: async ({ body, file }) => {
      const saved = isEdit ? await sitesApi.update(site.site_id, body) : await sitesApi.create(body);
      if (file) return sitesApi.uploadImage(saved.site_id, file);
      return saved;
    },
    onSuccess: (saved) => {
      setErrors({});
      toast.success(isEdit ? "Site updated" : "Site created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function buildAddress() {
    const obj = {
      street: street.trim() || null,
      city: city.trim() || null,
      state: state.trim() || null,
      zip_code: zipCode.trim() || null,
      country: country.trim() || null,
    };
    return Object.values(obj).some(Boolean) ? obj : null;
  }
  function buildCoords() {
    if (latitude === "" || longitude === "") return null;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { latitude: lat, longitude: lng };
  }

  function submit(e) {
    e.preventDefault();
    setErrors({});
    if (!name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    saving.mutate({
      body: {
        name: name.trim(),
        location_code: locationCode.trim() || null,
        description: description.trim() || null,
        site_type: siteType,
        parent_id: parentId || null,
        threat_level: threatLevel,
        address: buildAddress(),
        coordinates: buildCoords(),
        contact_person: contactPerson.trim() || null,
        contact_phone: contactPhone.trim() || null,
        email_address: emailAddress.trim() || null,
      },
      file: imageFile,
    });
  }

  function onPickImage(e) {
    const file = e.target.files?.[0] || null;
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp|svg\+xml)$/i.test(file.type)) {
      toast.error("Use PNG, JPEG, WEBP, or SVG image");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Site image must be 8 MiB or smaller");
      return;
    }
    setImageFile(file);
  }

  const parentChoices = (allSites || []).filter((s) => s.site_id !== site?.site_id);

  return (
    <Overlay onClose={onCancel}>
      <div className="relative w-full max-w-3xl rounded-xl bg-nb-panel border border-nb-line shadow-2xl animate-modal-in flex flex-col max-h-[85vh] text-nb-ink">
        <div className="flex items-center justify-between border-b border-nb-line px-5 py-4 shrink-0">
          <div>
            <h3 className="text-base font-semibold text-nb-ink">{isEdit ? `Edit ${site?.name || "site"}` : "Create site"}</h3>
            <p className="text-xs text-nb-soft mt-0.5">
              {isEdit ? "Update location details and contact info." : "Add a new physical location."}
            </p>
          </div>
          <button onClick={onCancel} className="text-nb-muted hover:text-nb-blueb transition">
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        <form noValidate onSubmit={submit} className="flex flex-col min-h-0 flex-1">
          <div className="flex-1 px-6 py-6 space-y-6 overflow-y-auto scroll-none">
            <Section title="Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <FieldLabel required>Name</FieldLabel>
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (errors.name) setErrors({});
                    }}
                    placeholder="Enter site name"
                    className={`${fieldClass} ${errors.name ? "!border-nb-crit" : ""}`}
                  />
                  {errors.name && <p className="mt-1 text-xs text-nb-crit">{errors.name}</p>}
                </div>
                <div>
                  <FieldLabel>Location code</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input value={locationCode} onChange={(e) => setLocationCode(e.target.value)} placeholder="Enter location code" className="h-10 flex-1 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 text-sm font-mono text-nb-ink outline-none focus:border-nb-blue" />
                    {!isEdit && (
                      <button type="button" onClick={() => setLocationCode(generateLocationCode(siteType))} className="inline-flex items-center justify-center rounded-[9px] border border-nb-line bg-[rgba(10,18,40,.65)] px-3 text-xs font-medium text-nb-muted hover:border-nb-blue hover:text-nb-blueb">
                        Regenerate
                      </button>
                    )}
                  </div>
                  {!isEdit && <p className="mt-1 text-[11px] text-nb-faint">Auto-generated from site type. Edit or regenerate as you like.</p>}
                </div>
                <FSelect
                  label="Site type"
                  value={siteType}
                  onChange={setSiteType}
                  options={SITE_TYPES.map((t) => ({ value: t, label: capitalize(t) }))}
                />
                <FSelect
                  label="Threat level"
                  value={threatLevel}
                  onChange={setThreatLevel}
                  options={THREAT_LEVELS.map((t) => ({ value: t, label: capitalize(t) }))}
                />
                <FSelect
                  label="Parent site"
                  value={parentId}
                  onChange={setParentId}
                  full
                  placeholder="No parent"
                  options={[
                    { value: "", label: "No parent" },
                    ...parentChoices.map((s) => ({
                      value: s.site_id,
                      label: `${s.name}${s.location_code ? ` · ${s.location_code}` : ""}`,
                    })),
                  ]}
                />
                <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Site description (optional)" />
              </div>
            </Section>
            <Section title="Address">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Street" full value={street} onChange={setStreet} placeholder="Street address" />
                <FInput label="City" value={city} onChange={setCity} placeholder="City" />
                <FInput label="State / region" value={state} onChange={setState} placeholder="State or region" />
                <FInput label="Zip code" value={zipCode} onChange={setZipCode} placeholder="Zip code" />
                <FInput label="Country" value={country} onChange={setCountry} placeholder="Country" />
              </div>
            </Section>
            <Section
              title="Coordinates (optional)"
              action={
                mapsKey ? (
                  <GeocodeButton
                    apiKey={mapsKey}
                    address={{ street, city, state, zipCode, country }}
                    onResult={({ latitude: lat, longitude: lng, formatted }) => {
                      setLatitude(lat.toFixed(6));
                      setLongitude(lng.toFixed(6));
                      setGeoMatch(formatted);
                    }}
                  />
                ) : null
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Latitude" type="number" step="any" value={latitude} onChange={(v) => { setLatitude(v); setGeoMatch(""); }} placeholder="Latitude" />
                <FInput label="Longitude" type="number" step="any" value={longitude} onChange={(v) => { setLongitude(v); setGeoMatch(""); }} placeholder="Longitude" />
              </div>
              {geoMatch && (
                <p className="mt-2 flex items-start gap-1.5 text-[11px] text-nb-blueb">
                  <Icon icon="heroicons-outline:map-pin" className="mt-px shrink-0 text-[13px]" />
                  <span>Matched <b>{geoMatch}</b> — adjust the values if the pin is off.</span>
                </p>
              )}
              <p className="mt-2 text-[11px] text-nb-faint">
                Sites with coordinates appear as pins on the <b>Map view</b>.
                {mapsKey ? " Fetch from address needs the full address above — street, city, state, zip code and country." : ""}
              </p>
            </Section>
            <Section title="Contact">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <FInput label="Contact person" value={contactPerson} onChange={setContactPerson} placeholder="Contact person name" />
                <FInput label="Contact phone" value={contactPhone} onChange={setContactPhone} placeholder="Contact phone number" />
                <FInput label="Email" type="email" value={emailAddress} onChange={setEmailAddress} placeholder="Contact email address" />
                <div>
                  <FieldLabel>Site image</FieldLabel>
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={onPickImage} className="mt-1 block w-full rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2 text-sm text-nb-ink" />
                  <p className="mt-1 text-[11px] text-nb-faint">Allowed: PNG, JPEG, WEBP, SVG (max 8 MiB)</p>
                  <div className="mt-3">
                    <ImagePreviewCard
                      title="Preview"
                      subtitle={
                        imageFile
                          ? `${imageFile.name} · ${(imageFile.size / (1024 * 1024)).toFixed(2)} MiB`
                          : existingImageUrl
                            ? "Currently uploaded site image"
                            : "No site image uploaded yet"
                      }
                      imageUrl={previewUrl}
                      emptyText="Current uploaded image will appear here"
                    />
                  </div>
                </div>
              </div>
            </Section>
          </div>
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-nb-line shrink-0">
            <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={saving.isPending}>
              {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create site"}
            </Button>
          </div>
        </form>
      </div>
    </Overlay>
  );
}
