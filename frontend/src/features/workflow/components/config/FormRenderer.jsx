"use client";

// Pure per-field input renderer for the dynamic-form live preview + submit-test.
// Works off the v3 field shape:
//   { id, label, type, placeholder, options:[{value,label}], validation:{ required, pattern } }
import { fieldClass, areaClass, FieldLabel } from "@/components/common";

export default function FormRenderer({ field, value, onChange, error, disabled = false }) {
  const id = `ff-${field.id || field._key || "x"}`;
  const required = !!field?.validation?.required;
  const pattern = field?.validation?.pattern || undefined;
  const set = (v) => onChange?.(v);
  const opts = (field.options || []).map((o) =>
    typeof o === "string" ? { value: o, label: o } : { value: o.value ?? o.label, label: o.label ?? o.value },
  );

  // boolean/checkbox render as a single toggle with an inline label.
  if (field.type === "boolean" || field.type === "checkbox") {
    return (
      <div>
        <label className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input id={id} type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => set(e.target.checked)} />
          <span>{field.label || field.id}{required && <span className="ml-1 text-red-500">*</span>}</span>
        </label>
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
    );
  }

  let control;
  switch (field.type) {
    case "textarea":
      control = <textarea id={id} rows={3} disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} className={`${areaClass} ${error ? "!border-red-500" : ""}`} />;
      break;
    case "number":
      control = <input id={id} type="number" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} placeholder={field.placeholder || ""} className={`${fieldClass} ${error ? "!border-red-500" : ""}`} />;
      break;
    case "date":
      control = <input id={id} type="date" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${error ? "!border-red-500" : ""}`} />;
      break;
    case "datetime":
      control = <input id={id} type="datetime-local" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${error ? "!border-red-500" : ""}`} />;
      break;
    case "file":
      control = <input id={id} type="file" disabled={disabled} onChange={(e) => set(e.target.files?.[0]?.name || "")} className={`${fieldClass} ${error ? "!border-red-500" : ""}`} />;
      break;
    case "select":
      control = (
        <select id={id} disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${error ? "!border-red-500" : ""}`}>
          <option value="" className="bg-card">— select —</option>
          {opts.map((o) => <option key={o.value} value={o.value} className="bg-card">{o.label}</option>)}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="mt-1 flex flex-col gap-1.5">
          {opts.length === 0 && <span className="text-xs text-muted/70">No options</span>}
          {opts.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
              <input type="radio" name={id} disabled={disabled} checked={value === o.value} onChange={() => set(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    default:
      control = <input id={id} type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"} disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} pattern={pattern} className={`${fieldClass} ${error ? "!border-red-500" : ""}`} />;
  }

  return (
    <div>
      <FieldLabel required={required}>{field.label || field.id}</FieldLabel>
      {control}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
