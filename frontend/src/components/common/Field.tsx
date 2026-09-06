"use client";

// Canonical form field — replaces the FLabel + FIELD_CLS pair that was
// copy-pasted into ~4 feature forms. Uppercase-muted label + themed control,
// with optional `required`, `error`, and `hint`. Supports text/number/date
// inputs, textarea, and select (options list) through one API.
//
//   <Field label="Name" required value={name} onChange={(e)=>setName(e.target.value)} error={err} />
//   <Field label="Notes" as="textarea" rows={3} value={notes} onChange={...} />
//   <Field label="Priority" as="select" value={p} onChange={...} options={[{value,label}]} />

import type { ChangeEvent, ComponentPropsWithoutRef, ReactNode } from "react";

import SelectMenu, { type SelectChangeEvent, type SelectOption } from "./SelectMenu";

// Base control classes (shared so raw inputs match Field visually).
export const fieldClass =
  "mt-1 h-10 w-full rounded-lg border border-nb-line bg-nb-field px-3 text-sm text-nb-ink placeholder:text-nb-faint outline-hidden transition focus:border-nb-teal focus:ring-1 focus:ring-nb-teal/40";
export const areaClass =
  "mt-1 w-full rounded-lg border border-nb-line bg-nb-field px-3 py-2 text-sm text-nb-ink placeholder:text-nb-faint outline-hidden transition focus:border-nb-teal focus:ring-1 focus:ring-nb-teal/40";

export interface FieldLabelProps {
  children?: ReactNode;
  required?: boolean;
  className?: string;
}

export function FieldLabel({ children, required, className = "" }: FieldLabelProps) {
  return (
    <label className={`font-mono text-xs font-medium uppercase tracking-wide text-nb-muted ${className}`}>
      {children}
      {required && <span className="ml-1 text-nb-crit">*</span>}
    </label>
  );
}

/** What a Field's `onChange` receives: the native event for an input/textarea,
 *  or SelectMenu's `{ target: { value } }` for `as="select"`. `e.target.value` is
 *  a string on every branch; anything beyond that needs the native event. */
export type FieldChangeEvent = ChangeEvent<HTMLInputElement | HTMLTextAreaElement> | SelectChangeEvent;

/** The DOM attributes shared by the three controls, minus the ones Field owns. */
type FieldControlProps = Omit<
  ComponentPropsWithoutRef<"input"> & ComponentPropsWithoutRef<"textarea">,
  "onChange" | "className" | "value" | "as"
>;

export interface FieldProps extends FieldControlProps {
  label?: ReactNode;
  required?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  as?: "input" | "textarea" | "select";
  /** `as="select"` only. */
  options?: SelectOption[];
  className?: string;
  containerClassName?: string;
  value?: string | number | null;
  onChange?: (e: FieldChangeEvent) => void;
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
}: FieldProps) {
  const errCls = error ? "!border-nb-crit" : "";
  // Keep controlled inputs controlled. For a value-controlled input/textarea, force
  // a defined value ("") whenever the caller's value is null/undefined — even a
  // number field whose value momentarily becomes undefined (e.g. form re-hydrates
  // on camera switch) would otherwise flip controlled→uncontrolled and warn. A
  // checkbox/radio uses `checked`, so coerce that to false the same way.
  if ("checked" in control) {
    if (control.checked == null) control.checked = false;
  } else if (as !== "select" && control.value == null) {
    control.value = "";
  }
  // A null value is only ever coerced for input/textarea above; SelectMenu takes
  // it as "nothing selected". `value ?? undefined` keeps the DOM attribute typed.
  const { value, onChange, ...rest } = control;
  return (
    <div className={containerClassName}>
      {label && <FieldLabel required={required}>{label}</FieldLabel>}
      {as === "textarea" ? (
        <textarea {...rest} value={value ?? undefined} onChange={onChange} className={`${areaClass} ${errCls} ${className}`} />
      ) : as === "select" ? (
        <SelectMenu
          options={options}
          value={value}
          onChange={onChange}
          disabled={rest.disabled}
          placeholder={rest.placeholder}
          id={rest.id}
          name={rest.name}
          className={`${errCls} ${className}`}
        />
      ) : (
        <input {...rest} value={value ?? undefined} onChange={onChange} className={`${fieldClass} ${errCls} ${className}`} />
      )}
      {error ? (
        <p className="mt-1 text-xs text-nb-crit">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-[11px] text-nb-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export default Field;
