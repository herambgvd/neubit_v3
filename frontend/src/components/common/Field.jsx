"use client";

// Canonical form field — replaces the FLabel + FIELD_CLS pair that was
// copy-pasted into ~4 feature forms. Uppercase-muted label + themed control,
// with optional `required`, `error`, and `hint`. Supports text/number/date
// inputs, textarea, and select (options list) through one API.
//
//   <Field label="Name" required value={name} onChange={(e)=>setName(e.target.value)} error={err} />
//   <Field label="Notes" as="textarea" rows={3} value={notes} onChange={...} />
//   <Field label="Priority" as="select" value={p} onChange={...} options={[{value,label}]} />

import SelectMenu from "./SelectMenu";

// Base control classes (shared so raw inputs match Field visually).
export const fieldClass =
  "mt-1 h-10 w-full rounded-lg border border-field bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";
export const areaClass =
  "mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted";

export function FieldLabel({ children, required, className = "" }) {
  return (
    <label className={`text-xs font-medium uppercase tracking-wide text-muted ${className}`}>
      {children}
      {required && <span className="ml-1 text-red-500">*</span>}
    </label>
  );
}

export function Field({
  label,
  required,
  error,
  hint,
  as = "input",
  options = [],
  className = "",
  containerClassName = "",
  ...control
}) {
  const errCls = error ? "!border-red-500" : "";
  // Keep controlled inputs controlled: if a `value` prop is passed but is
  // null/undefined, coerce to "" so React never flips controlled↔uncontrolled
  // (a defined→undefined value throws the "changing a controlled input" warning).
  if ("value" in control && control.value == null) control.value = "";
  return (
    <div className={containerClassName}>
      {label && <FieldLabel required={required}>{label}</FieldLabel>}
      {as === "textarea" ? (
        <textarea {...control} className={`${areaClass} ${errCls} ${className}`} />
      ) : as === "select" ? (
        <SelectMenu
          options={options}
          value={control.value}
          onChange={control.onChange}
          disabled={control.disabled}
          placeholder={control.placeholder}
          id={control.id}
          name={control.name}
          className={`${errCls} ${className}`}
        />
      ) : (
        <input {...control} className={`${fieldClass} ${errCls} ${className}`} />
      )}
      {error ? (
        <p className="mt-1 text-xs text-red-500">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-muted/70">{hint}</p>
      ) : null}
    </div>
  );
}

export default Field;
