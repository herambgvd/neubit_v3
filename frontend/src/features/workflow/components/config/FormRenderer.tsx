"use client";

// Pure per-field input renderer for the dynamic-form live preview + submit-test.
// Works off the v3 field shape:
//   { id, label, type, placeholder, options:[{value,label}], validation:{ required, pattern } }
import type { ReactNode } from "react";
import { fieldClass, areaClass, FieldLabel } from "@/components/common";
import { checkboxClass } from "@/components/ui/kit";
import SelectMenu from "@/components/common/SelectMenu";
import type { FormFieldSchema, FormFieldValue } from "../../types";

// Text-ish controls only ever hold a string or a number; anything else renders empty.
const asText = (v: FormFieldValue | undefined): string | number =>
  typeof v === "string" || typeof v === "number" ? v : "";

export interface FormRendererProps {
  field: FormFieldSchema;
  value: FormFieldValue | undefined;
  onChange?: (value: FormFieldValue) => void;
  error?: string | null;
  disabled?: boolean;
}

/** The HTML input type a field definition asks for. A field type this renderer
 *  has no special control for falls back to plain text rather than to whatever
 *  the last arm of a chain happened to be. */
const INPUT_TYPE: Record<string, string> = {
  email: "email",
  phone: "tel",
};

/** One resolved option — `{value,label}` with either side standing in for a
 *  missing other, which is the shape every option-driven control below wants. */
interface FieldOption {
  value: string;
  label: string;
}

interface OptionControlProps {
  opts: readonly FieldOption[];
  disabled: boolean;
  value: FormFieldValue | undefined;
  onSet: (v: FormFieldValue) => void;
}

/** Multi-select, lifted out of the switch because its checked/unchecked arms are
 *  a list edit, not a render: the box a viewer ticks adds to the array and the
 *  one they untick filters it, and that belongs somewhere it can be read on its
 *  own rather than four levels inside a case. */
function MultiSelectControl({ opts, disabled, value, onSet }: Readonly<OptionControlProps>) {
  const arr = Array.isArray(value) ? value : [];
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-nb-line bg-transparent p-2">
      {opts.length === 0 && <span className="text-xs text-nb-faint/70 px-1">No options</span>}
      {opts.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-2 text-sm text-nb-ink cursor-pointer">
          <input
            type="checkbox"
            className={checkboxClass}
            disabled={disabled}
            checked={arr.includes(o.value)}
            onChange={(e) => onSet(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A five-star rating. Pressing the star that is already the score clears it —
 *  the only way back to "not answered" once a star has been pressed, which an
 *  optional rating field needs. */
function RatingControl({ disabled, value, onSet }: Readonly<Omit<OptionControlProps, "opts">>) {
  const num = Number(value) || 0;
  return (
    <div className="mt-1 inline-flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onSet(n === num ? 0 : n)}
          title={`${n} of 5`}
          className={`text-lg leading-none ${n <= num ? "text-nb-warn" : "text-nb-faint/40"} hover:text-nb-warn disabled:cursor-not-allowed`}
        >
          ★
        </button>
      ))}
      <span className="ml-1.5 text-xs text-nb-faint">{num || "—"}/5</span>
    </div>
  );
}

/** The radio group. Same reason as the two above: it is a list, not a control. */
function RadioControl({ id, opts, disabled, value, onSet }: Readonly<OptionControlProps & { id: string }>) {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {opts.length === 0 && <span className="text-xs text-nb-faint/70">No options</span>}
      {opts.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-2 text-sm text-nb-ink cursor-pointer">
          <input type="radio" name={id} disabled={disabled} checked={value === o.value} onChange={() => onSet(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export default function FormRenderer({ field, value, onChange, error, disabled = false }: Readonly<FormRendererProps>) {
  const id = `ff-${field.id || "x"}`;
  const required = !!field?.validation?.required;
  const pattern = field?.validation?.pattern || undefined;
  const set = (v: FormFieldValue) => onChange?.(v);
  const opts: FieldOption[] = (field.options || []).map((o) => ({ value: o.value ?? o.label, label: o.label ?? o.value }));
  // Decided once. It was the same ternary inside seven different className
  // templates, so a change to how an invalid field looks meant seven edits and
  // the chance of six.
  const errCls = error ? "!border-nb-crit" : "";

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

  let control: ReactNode;
  switch (field.type) {
    case "textarea":
      control = <textarea id={id} rows={3} disabled={disabled} value={asText(value)} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} className={`${areaClass} ${errCls}`} />;
      break;
    case "number":
      control = <input id={id} type="number" disabled={disabled} value={asText(value)} onChange={(e) => set(e.target.value === "" ? "" : Number(e.target.value))} placeholder={field.placeholder || ""} className={`${fieldClass} ${errCls}`} />;
      break;
    case "date":
      control = <input id={id} type="date" disabled={disabled} value={asText(value)} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${errCls}`} />;
      break;
    case "datetime":
      control = <input id={id} type="datetime-local" disabled={disabled} value={asText(value)} onChange={(e) => set(e.target.value)} className={`${fieldClass} ${errCls}`} />;
      break;
    case "file":
      control = <input id={id} type="file" disabled={disabled} onChange={(e) => set(e.target.files?.[0]?.name || "")} className={`${fieldClass} ${errCls}`} />;
      break;
    case "select":
      control = (
        <SelectMenu
          id={id}
          disabled={disabled}
          value={String(asText(value))}
          onChange={(e) => set(e.target.value)}
          placeholder="— select —"
          options={opts}
          className={errCls}
        />
      );
      break;
    case "radio":
      control = <RadioControl id={id} opts={opts} disabled={disabled} value={value} onSet={set} />;
      break;
    case "multiselect":
      control = <MultiSelectControl opts={opts} disabled={disabled} value={value} onSet={set} />;
      break;
    case "rating":
      control = <RatingControl disabled={disabled} value={value} onSet={set} />;
      break;
    default:
      control = <input id={id} type={INPUT_TYPE[field.type] ?? "text"} disabled={disabled} value={asText(value)} onChange={(e) => set(e.target.value)} placeholder={field.placeholder || ""} pattern={pattern} className={`${fieldClass} ${errCls}`} />;
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
