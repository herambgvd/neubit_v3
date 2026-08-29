"use client";

// Pure per-field input renderer for the dynamic-form live preview + submit-test.
// Works off the v3 field shape:
//   { id, label, type, placeholder, options:[{value,label}], validation:{ required, pattern } }
import { fieldClass, areaClass, FieldLabel } from "@/components/common";
import { checkboxClass } from "@/components/ui/kit";
import SelectMenu from "@/components/common/SelectMenu";

export default function FormRenderer({ field, value, onChange, error, disabled = false }: any) {
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
        <label className="inline-flex items-center gap-2 text-sm text-nb-ink cursor-pointer">
          <input id={id} type="checkbox" disabled={disabled} checked={!!value} onChange={(e) => set(e.target.checked)} className={checkboxClass} />
          <span>{field.label || field.id}{required && <span className="ml-1 text-nb-crit">*</span>}</span>
        </label>
        {field.help_text && <p className="mt-1 text-[11px] text-nb-faint/70">{field.help_text}</p>}
        {error && <p className="mt-1 text-xs text-nb-crit">{error}</p>}
      </div>
    );
  }

  let control;
  switch (field.type) {
    case "textarea":
      control = <textarea id={id} rows={3} disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} className={`${areaClass} ${error ? "!border-nb-crit" : ""}`} />;
      break;
    case "number":
      control = <input id={id} type="number" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} placeholder={field.placeholder || ""} className={`${fieldClass} ${error ? "!border-nb-crit" : ""}`} />;
      break;
    case "date":
      control = <input id={id} type="date" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${error ? "!border-nb-crit" : ""}`} />;
      break;
    case "datetime":
      control = <input id={id} type="datetime-local" disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${error ? "!border-nb-crit" : ""}`} />;
      break;
    case "file":
      control = <input id={id} type="file" disabled={disabled} onChange={(e) => set(e.target.files?.[0]?.name || "")} className={`${fieldClass} ${error ? "!border-nb-crit" : ""}`} />;
      break;
    case "select":
      control = (
        <SelectMenu
          id={id}
          disabled={disabled}
          value={value ?? ""}
          onChange={(e) => set(e.target.value)}
          placeholder="— select —"
          options={opts.map((o) => ({ value: o.value, label: o.label }))}
          className={error ? "!border-nb-crit" : ""}
        />
      );
      break;
    case "radio":
      control = (
        <div className="mt-1 flex flex-col gap-1.5">
          {opts.length === 0 && <span className="text-xs text-nb-faint/70">No options</span>}
          {opts.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-2 text-sm text-nb-ink cursor-pointer">
              <input type="radio" name={id} disabled={disabled} checked={value === o.value} onChange={() => set(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "multiselect": {
      const arr = Array.isArray(value) ? value : [];
      control = (
        <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-nb-line bg-transparent p-2">
          {opts.length === 0 && <span className="text-xs text-nb-faint/70 px-1">No options</span>}
          {opts.map((o) => (
            <label key={o.value} className="inline-flex items-center gap-2 text-sm text-nb-ink cursor-pointer">
              <input
                type="checkbox"
                className={checkboxClass}
                disabled={disabled}
                checked={arr.includes(o.value)}
                onChange={(e) => set(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
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
              disabled={disabled}
              onClick={() => set(n === num ? 0 : n)}
              title={`${n} of 5`}
              className={`text-lg leading-none ${n <= num ? "text-nb-warn" : "text-nb-faint/40"} hover:text-nb-warn disabled:cursor-not-allowed`}
            >
              ★
            </button>
          ))}
          <span className="ml-1.5 text-xs text-nb-faint">{num || "—"}/5</span>
        </div>
      );
      break;
    }
    default:
      control = <input id={id} type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : "text"} disabled={disabled} value={value ?? ""} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} pattern={pattern} className={`${fieldClass} ${error ? "!border-nb-crit" : ""}`} />;
  }

  return (
    <div>
      <FieldLabel required={required}>{field.label || field.id}</FieldLabel>
      {control}
      {field.help_text && <p className="mt-1 text-[11px] text-nb-faint/70">{field.help_text}</p>}
      {error && <p className="mt-1 text-xs text-nb-crit">{error}</p>}
    </div>
  );
}
