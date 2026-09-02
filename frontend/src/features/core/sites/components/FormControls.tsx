"use client";

// Small themed form-control wrappers shared by the sites feature's forms
// (FloorForm, ZoneForm, SiteFormModal). Built on the shared `FieldLabel` +
// `fieldClass` / `areaClass` from @/components/common so labels and inputs match
// the rest of the app — this replaces the old per-file label + input-class pair.
import { FieldLabel, fieldClass, areaClass } from "@/components/common";
import SelectMenu from "@/components/common/SelectMenu";
import { Checkbox } from "@/components/ui/kit";

// `error` and `hint` behave exactly like kit's <Input> / common's <Field>: red
// border, red message in place of the hint. `action` puts a control beside the
// field (Regenerate) — that row used to be hand-built with its own input classes,
// so the Location code box didn't match the Name box next to it.
export function FInput({
  label, required, full, value, onChange, placeholder, type = "text", inputMode, step, min, error, hint, action, mono,
}: any) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <div className={action ? "mt-1 flex gap-2" : ""}>
        <input
          type={type}
          inputMode={inputMode}
          step={step}
          min={min}
          value={value === null || value === undefined ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className={`${fieldClass} ${action ? "!mt-0 flex-1" : ""} ${mono ? "font-mono" : ""} ${
            error ? "!border-nb-crit" : ""
          }`}
        />
        {action}
      </div>
      {error ? (
        <p className="mt-1 text-xs text-nb-crit">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-nb-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function FTextarea({ label, full, value, onChange, rows, placeholder }: any) {
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

// `options` is [{ value, label }] — the same shape every other picker in the app
// takes. This was a native <select> fed <option> children, which is why the site
// forms showed an OS-styled dropdown next to the app's own everywhere else.
export function FSelect({ label, full, required, value, onChange, options = [], placeholder }: any) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <FieldLabel required={required}>{label}</FieldLabel>
      <SelectMenu
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        options={options}
        placeholder={placeholder}
      />
    </div>
  );
}

export function FCheckbox({ label, value, onChange }: any) {
  return (
    <div className="flex h-10 items-center rounded-lg border border-nb-line px-3">
      <Checkbox label={label} checked={value} onChange={onChange} />
    </div>
  );
}

export function ImagePreviewCard({ title, subtitle, imageUrl, emptyText }: any) {
  return (
    <div className="rounded-lg border border-nb-line bg-[rgba(8,15,34,.5)] overflow-hidden">
      <div className="px-3 py-2 border-b border-nb-line bg-white/5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-nb-muted">{title}</p>
        <p className="text-[11px] text-nb-faint truncate">{subtitle}</p>
      </div>
      <div className="p-3">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt={`${title} preview`} className="h-28 w-full rounded-md border border-nb-line object-cover" />
        ) : (
          <div className="h-28 w-full rounded-md border border-dashed border-nb-line bg-white/[.04] px-3 flex items-center justify-center text-center text-[11px] text-nb-faint">
            {emptyText}
          </div>
        )}
      </div>
    </div>
  );
}

// Titled section wrapper for the site create/edit modal. `action` renders an
// optional control (e.g. "Fetch from address") on the right of the heading.
export function Section({ title, action, children }: any) {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-nb-muted">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}
