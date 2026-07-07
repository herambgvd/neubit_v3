"use client";

// Dynamic form field renderer (text / textarea / number / date / boolean /
// select / multiselect). Used by TransitionFormModal to render a SOP form's
// fields. Reads label/required from the backend FormFieldSchema shape.

// Form field id + required (backend FormFieldSchema: {id, validation:{required}}).
export const fieldKey = (f) => f?.id ?? f?.key ?? f?.label;
export const fieldRequired = (f) => !!(f?.validation?.required ?? f?.required);

export default function FormFieldInput({ field, value, error, onChange }) {
  const label = (
    <label className="text-xs font-medium uppercase tracking-wide text-muted">
      {field.label || fieldKey(field)}
      {fieldRequired(field) && <span className="text-red-500 ml-1">*</span>}
    </label>
  );
  const cls = `mt-1 h-10 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted`;
  const options = Array.isArray(field.options)
    ? field.options.map((o) => (typeof o === "object" ? o : { value: o, label: o }))
    : [];

  return (
    <div>
      {label}
      {field.type === "textarea" ? (
        <textarea
          rows={3}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || ""}
          className={`mt-1 w-full rounded-lg border ${error ? "border-red-500" : "border-field"} bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none transition focus:border-muted`}
        />
      ) : field.type === "boolean" ? (
        <label className="mt-1 flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.placeholder || "Yes"}
        </label>
      ) : field.type === "select" || field.type === "multiselect" ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        >
          <option value="" className="bg-card">Select…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-card">{o.label}</option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder || ""}
          className={cls}
        />
      )}
      {field.help_text && <p className="mt-1 text-[11px] text-muted/70">{field.help_text}</p>}
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </div>
  );
}
