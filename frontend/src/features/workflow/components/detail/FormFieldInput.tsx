"use client";

// Dynamic form field renderer (text / textarea / number / date / boolean /
// select / multiselect). Used by TransitionFormModal to render a SOP form's
// fields. Reads label/required from the backend FormFieldSchema shape.
import type { FormFieldSchema, FormFieldValue } from "../../types";

// Form field id + required (backend FormFieldSchema: {id, validation:{required}}).
export const fieldKey = (f: FormFieldSchema): string => f.id ?? f.label;
export const fieldRequired = (f: FormFieldSchema): boolean => !!f.validation?.required;

// Text-ish controls only ever hold a string or a number; anything else renders empty.
const asText = (v: FormFieldValue | undefined): string | number =>
  typeof v === "string" || typeof v === "number" ? v : "";

export interface FormFieldInputProps {
  field: FormFieldSchema;
  value: FormFieldValue | undefined;
  error?: string;
  onChange: (value: FormFieldValue) => void;
}

const INPUT_TYPE: Record<string, string> = {
  number: "number",
  date: "date",
};

/** What a typed input hands back to the form. A cleared NUMBER field returns ""
 *  and not 0 — the difference between "nobody answered" and "they answered
 *  zero", which on a form attached to an incident is not a distinction to lose. */
export function readInput(fieldType: string, raw: string): string | number {
  if (fieldType !== "number") return raw;
  return raw === "" ? "" : Number(raw);
}

export default function FormFieldInput({ field, value, error, onChange }: Readonly<FormFieldInputProps>) {
  const label = (
    <label className="text-xs font-medium uppercase tracking-wide text-muted">
      {field.label || fieldKey(field)}
      {fieldRequired(field) && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
  const cls = `mt-1 h-10 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-hidden transition focus:border-muted`;
  const options = field.options ?? [];

  // A switch, not a ternary ladder: this is the same dispatch FormRenderer makes
  // over the same field types, and the two are read side by side.
  let control;
  switch (field.type) {
    case "textarea":
      control = (
        <textarea
          rows={3}
          value={asText(value) || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || ""}
          className={`mt-1 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-hidden transition focus:border-muted`}
        />
      );
      break;
    case "boolean":
      control = (
        <label className="mt-1 flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.placeholder || "Yes"}
        </label>
      );
      break;
    case "select":
      control = (
        <select
          value={asText(value) || ""}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        >
          <option value="" className="bg-card">Select…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-card">{o.label}</option>
          ))}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="mt-1 flex flex-col gap-1.5">
          {options.length === 0 && <span className="text-xs text-muted/70">No options</span>}
          {options.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input type="radio" checked={value === o.value} onChange={() => onChange(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "multiselect": {
      const arr = Array.isArray(value) ? value : [];
      control = (
        <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-field bg-transparent p-2">
          {options.length === 0 && <span className="text-xs text-muted/70 px-1">No options</span>}
          {options.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={arr.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case "rating": {
      const num = Number(value) || 0;
      control = (
        <div className="mt-1 inline-flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n === num ? 0 : n)}
              title={`${n} of 5`}
              className={`text-lg leading-none ${n <= num ? "text-amber-400" : "text-muted/40"} hover:text-amber-400`}
            >
              ★
            </button>
          ))}
          <span className="ml-1.5 text-xs text-muted">{num || "—"}/5</span>
        </div>
      );
      break;
    }
    default:
      control = (
        <input
          type={INPUT_TYPE[field.type] ?? "text"}
          value={asText(value)}
          onChange={(e) => onChange(readInput(field.type, e.target.value))}
          placeholder={field.placeholder || ""}
          className={cls}
        />
      );
  }

  return (
    <div>
      {label}
      {control}
      {field.help_text && <p className="mt-1 text-[11px] text-muted/70">{field.help_text}</p>}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
