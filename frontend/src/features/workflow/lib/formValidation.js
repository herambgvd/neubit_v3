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

const isEmpty = (v) =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim() === "") ||
  (Array.isArray(v) && v.length === 0);

const OPTION_TYPES = new Set(["select", "radio"]);
const TEXTISH = new Set(["text", "textarea", "email", "phone"]);

export function fieldKey(f, i) {
  return f.id || (f.label ? `f_${i}` : `field_${i + 1}`);
}

// Validate one field's value; return an error string or null.
export function validateField(field, value) {
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "Must be a valid email";
  }

  if (OPTION_TYPES.has(field.type)) {
    const allowed = (field.options || []).map((o) => o.value ?? o.label ?? o);
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

// Validate a whole form. Returns { errors: { [key]: msg }, formData, valid }.
export function validateForm(fields, values) {
  const errors = {};
  const formData = {};
  (fields || []).forEach((f, i) => {
    const key = fieldKey(f, i);
    const value = values[key];
    const err = validateField(f, value);
    if (err) errors[key] = err;
    if (!isEmpty(value)) formData[key] = value;
  });
  return { errors, formData, valid: Object.keys(errors).length === 0 };
}
