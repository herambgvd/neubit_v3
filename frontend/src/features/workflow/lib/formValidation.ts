// Client-side mirror of the backend dynamic-form validation. Used by the
// FormSubmitTestModal so operators can dry-run a form and see the resulting
// form_data JSON (or per-field errors) without an API call.
//
// v3 form field shape:
//   { id, label, type, options:[{value,label}], validation:{ required, pattern } }
//
// Rules enforced (mirror backend):
//   validation.required → value must be non-empty
//   type                → number must be numeric; select/radio value must be a
//                         known option
//   validation.pattern  → value must match the regex (text-ish fields only)

import type { FormFieldSchema, FormFieldValue, FormValues } from "../types";
import { isEmail } from "@/lib/validate";

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

const OPTION_TYPES = new Set<string>(["select", "radio"]);
const TEXTISH = new Set<string>(["text", "textarea", "email", "phone"]);

export function fieldKey(f: FormFieldSchema, i: number): string {
  return f.id || (f.label ? `f_${i}` : `field_${i + 1}`);
}

// Validate one field's value; return an error string or null.
export function validateField(field: FormFieldSchema, value: unknown): string | null {
  const required = !!field?.validation?.required;
  const pattern = field?.validation?.pattern;

  if (isEmpty(value)) {
    return required ? "This field is required" : null;
  }

  if (field.type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isNaN(n)) return "Must be a number";
  }

  if (field.type === "email" && typeof value === "string") {
    if (!isEmail(value)) return "Must be a valid email";
  }

  if (OPTION_TYPES.has(field.type)) {
    const allowed: unknown[] = (field.options || []).map((o) => o.value ?? o.label);
    if (allowed.length && !allowed.includes(value)) return "Not an allowed option";
  }

  if (pattern && (TEXTISH.has(field.type) || field.type === undefined)) {
    try {
      if (!new RegExp(pattern).test(String(value))) return "Does not match the required pattern";
    } catch {
      /* invalid pattern → skip (backend would surface a config error) */
    }
  }

  return null;
}

export interface FormValidation {
  errors: Record<string, string>;
  formData: Record<string, FormFieldValue>;
  valid: boolean;
}

// Validate a whole form. Returns { errors: { [key]: msg }, formData, valid }.
export function validateForm(fields: FormFieldSchema[] | null | undefined, values: FormValues): FormValidation {
  const errors: Record<string, string> = {};
  const formData: Record<string, FormFieldValue> = {};
  (fields || []).forEach((f, i) => {
    const key = fieldKey(f, i);
    const value = values[key];
    const err = validateField(f, value);
    if (err) errors[key] = err;
    if (value !== undefined && !isEmpty(value)) formData[key] = value;
  });
  return { errors, formData, valid: Object.keys(errors).length === 0 };
}
