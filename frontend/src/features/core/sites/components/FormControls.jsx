"use client";

// Small themed form-control wrappers shared by the sites feature's forms
// (FloorForm, ZoneForm, SiteFormModal). Built on the shared `FieldLabel` +
// `fieldClass` / `areaClass` from @/components/common so labels and inputs match
// the rest of the app — this replaces the old per-file label + input-class pair.
import { FieldLabel, fieldClass, areaClass } from "@/components/common";

export function FInput({ label, required, full, value, onChange, placeholder, type = "text", step, min }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <input
        type={type}
        step={step}
        min={min}
        value={value === null || value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={fieldClass}
      />
    </div>
  );
}

export function FTextarea({ label, full, value, onChange, rows, placeholder }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FieldLabel>{label}</FieldLabel>
      <textarea
        rows={rows}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={areaClass}
      />
    </div>
  );
}

export function FSelect({ label, full, required, value, onChange, children }) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        {children}
      </select>
    </div>
  );
}

export function FCheckbox({ label, value, onChange }) {
  return (
    <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-field bg-transparent text-sm cursor-pointer">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-foreground">{label}</span>
    </label>
  );
}

export function ImagePreviewCard({ title, subtitle, imageUrl, emptyText }) {
  return (
    <div className="rounded-lg border border-card-border bg-card overflow-hidden">
      <div className="px-3 py-2 border-b border-card-border bg-hover/40">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</p>
        <p className="text-[11px] text-muted/70 truncate">{subtitle}</p>
      </div>
      <div className="p-3">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={`${title} preview`} className="h-28 w-full rounded-md border border-card-border object-cover" />
        ) : (
          <div className="h-28 w-full rounded-md border border-dashed border-card-border bg-hover/30 px-3 flex items-center justify-center text-center text-[11px] text-muted/70">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

// Titled section wrapper for the site create/edit modal.
export function Section({ title, children }) {
  return (
    <section>
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted mb-3">{title}</h4>
      {children}
    </section>
  );
}
