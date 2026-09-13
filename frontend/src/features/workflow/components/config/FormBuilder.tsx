"use client";

// Builder for a dynamic form (attached to transitions). Name/description via the
// shared Field; each field is an editable, collapsible card with label + type +
// required + placeholder + default + help text + validation regex + options, and
// up/down reorder. Serialises to the backend FormFieldSchema shape on save
// (options → [{value,label}], validation → { required, pattern }, help_text,
// default_value, order). The right column is the live FormPreview.
import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Checkbox } from "@/components/ui/kit";
import SelectMenu from "@/components/common/SelectMenu";
import { Field, FieldLabel } from "@/components/common";
import { randomId } from "@/lib/random";
import { apiError } from "@/lib/api";
import { titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import type { CreateFormRequest, FieldType, FormFieldSchema, FormFieldValidation, FormPublic } from "../../types";
import FormPreview from "./FormPreview";
import { PaneForm } from "@/components/console";

// Form field kinds the builder can create (mirrors backend FieldType enum).
const FIELD_TYPES: FieldType[] = ["text", "textarea", "number", "email", "phone", "date", "datetime", "select", "radio", "multiselect", "checkbox", "boolean", "rating", "file"];
const isFieldType = (v: string): v is FieldType => (FIELD_TYPES as string[]).includes(v);
// Types that own an editable option list.
const FIELD_TYPES_WITH_OPTIONS = new Set<string>(["select", "radio", "multiselect"]);
// Types that accept a validation regex (only meaningful on strings).
const FIELD_TYPES_WITH_PATTERN = new Set<string>(["text", "textarea", "email", "phone", "number"]);

/** One editor row — the flat, text-first shape the cards edit (options is a
 *  comma string; validation is spread into `required` + `pattern`). */
export interface BuilderField {
  label: string;
  type: FieldType;
  required: boolean;
  options: string;
  placeholder: string;
  default_value: string | number;
  help_text: string;
  pattern: string;
  _collapsed: boolean;
  /** The editor's handle on this row. Rows can be moved and removed, and both
   *  `_collapsed` and the focused input belong to the FIELD, not to the third
   *  slot in the list — keying by position moves them to whatever slides into
   *  that slot. The wire shape is rebuilt on submit, so this never leaves. */
  _key: string;
}

const blankField = (): BuilderField => ({
  label: "",
  type: "text",
  required: false,
  options: "",
  placeholder: "",
  default_value: "",
  help_text: "",
  pattern: "",
  _collapsed: false,
  _key: randomId(),
});

/** A form field's default as editor text. */
function defaultText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Backend field → editor row (options list → comma string; validation → flat).
function hydrateField(f: FormFieldSchema): BuilderField {
  return {
    label: f.label || "",
    type: f.type || "text",
    required: !!f.validation?.required,
    options: (f.options || []).map((o) => o.label ?? o.value ?? "").join(", "),
    placeholder: f.placeholder || "",
    // `default_value` is `Any` on the wire; the editor holds text (numbers kept).
    // A structured default gets its JSON: the editor saves back whatever it is
    // shown, so `[object Object]` here would become the field's actual default.
    default_value: typeof f.default_value === "number" ? f.default_value : defaultText(f.default_value),
    help_text: f.help_text || "",
    pattern: f.validation?.pattern || "",
    _collapsed: false,
    _key: randomId(),
  };
}

export interface FormBuilderProps {
  /** The form being edited; null creates one. */
  form: FormPublic | null;
  onCancel: () => void;
  onSaved: () => void;
}

export default function FormBuilder({ form, onCancel, onSaved }: FormBuilderProps) {
  const isEdit = !!form;
  const [name, setName] = useState(form?.name || "");
  const [description, setDescription] = useState(form?.description || "");
  const [isActive, setIsActive] = useState(form?.is_active !== false);
  const [fields, setFields] = useState<BuilderField[]>(
    Array.isArray(form?.fields) && form.fields.length ? form.fields.map(hydrateField) : [blankField()],
  );
  const [errors, setErrors] = useState<Partial<Record<"name" | "fields", string>>>({});

  const saving = useMutation({
    mutationFn: (body: CreateFormRequest) => (form ? wfApi.forms.update(form.form_id, body) : wfApi.forms.create(body)),
    onSuccess: () => { toast.success(isEdit ? "Form updated" : "Form created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateField = (i: number, patch: Partial<BuilderField>) =>
    setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, blankField()]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, idx) => idx !== i));
  const moveField = (from: number, to: number) =>
    setFields((fs) => {
      if (to < 0 || to >= fs.length || from === to) return fs;
      const next = [...fs];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: Partial<Record<"name" | "fields", string>> = {};
    if (!name.trim()) next.name = "Name is required";
    const clean = fields.filter((f) => f.label.trim());
    if (clean.length === 0) next.fields = "Add at least one field";
    if (Object.keys(next).length) { setErrors(next); return; }
    const payloadFields = clean.map((f, i): FormFieldSchema => {
      const opts = FIELD_TYPES_WITH_OPTIONS.has(f.type)
        ? f.options.split(",").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
        : [];
      const validation: FormFieldValidation = { required: !!f.required };
      if (FIELD_TYPES_WITH_PATTERN.has(f.type) && f.pattern.trim()) validation.pattern = f.pattern.trim();
      const out: FormFieldSchema = {
        id: `f_${i}`,
        label: f.label.trim(),
        type: f.type,
        placeholder: f.placeholder.trim() || null,
        help_text: f.help_text.trim() || null,
        options: opts,
        validation,
        order: i,
      };
      if (f.default_value !== "" && f.default_value !== undefined && f.default_value !== null)
        out.default_value = f.default_value;
      return out;
    });
    saving.mutate({ name: name.trim(), description: description.trim() || null, fields: payloadFields, is_active: isActive });
  }

  return (
    <PaneForm
      title={form ? `Edit ${form.name}` : "New form"}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create form"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }}
          placeholder="e.g. Fire response checklist"
          error={errors.name}
        />
        <Field
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nb-faint">Fields</span>
          <button type="button" onClick={addField} className="text-xs text-nb-blueb hover:underline">+ Add field</button>
        </div>
        {errors.fields && <p className="mb-2 text-xs text-nb-crit">{errors.fields}</p>}
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={f._key} className="rounded-lg border border-nb-line bg-[rgba(8,15,34,.5)]">
              <header className="flex items-center gap-2 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => updateField(i, { _collapsed: !f._collapsed })}
                  title={f._collapsed ? "Expand" : "Collapse"}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-nb-faint hover:bg-[rgba(96,165,250,.1)] hover:text-nb-ink"
                >
                  <Icon icon={f._collapsed ? "heroicons-outline:chevron-right" : "heroicons-outline:chevron-down"} className="text-sm" />
                </button>
                <span className="text-xs font-semibold text-nb-ink">Field {i + 1}</span>
                <span className="text-xs text-nb-faint truncate">{f.label || "(unnamed)"}</span>
                <span className="ml-auto inline-flex items-center gap-0.5">
                  <button type="button" onClick={() => moveField(i, i - 1)} disabled={i === 0} title="Move up" className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-nb-faint hover:bg-[rgba(96,165,250,.1)] hover:text-nb-ink disabled:opacity-40 disabled:cursor-not-allowed">
                    <Icon icon="heroicons-outline:chevron-up" className="text-sm" />
                  </button>
                  <button type="button" onClick={() => moveField(i, i + 1)} disabled={i === fields.length - 1} title="Move down" className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-nb-faint hover:bg-[rgba(96,165,250,.1)] hover:text-nb-ink disabled:opacity-40 disabled:cursor-not-allowed">
                    <Icon icon="heroicons-outline:chevron-down" className="text-sm" />
                  </button>
                  <button type="button" onClick={() => removeField(i)} title="Delete field" className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-nb-faint hover:bg-[rgba(96,165,250,.1)] hover:text-nb-crit">
                    <Icon icon="heroicons-outline:x-mark" className="text-sm" />
                  </button>
                </span>
              </header>

              {!f._collapsed && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 border-t border-nb-line p-2.5">
                  <Field label="Label" required value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Field label" />
                  <div>
                    <FieldLabel>Type</FieldLabel>
                    <SelectMenu
                      value={f.type}
                      onChange={(e) => { if (isFieldType(e.target.value)) updateField(i, { type: e.target.value }); }}
                      options={FIELD_TYPES.map((t) => ({ value: t, label: titleize(t) }))}
                    />
                  </div>
                  <Field label="Placeholder" value={f.placeholder} onChange={(e) => updateField(i, { placeholder: e.target.value })} placeholder="Shown inside the input" />
                  <Field label="Default value" value={f.default_value} onChange={(e) => updateField(i, { default_value: e.target.value })} placeholder="Optional" />
                  <Field containerClassName="md:col-span-2" label="Help text" value={f.help_text} onChange={(e) => updateField(i, { help_text: e.target.value })} placeholder="Shown below the input" />
                  {FIELD_TYPES_WITH_OPTIONS.has(f.type) && (
                    <Field containerClassName="md:col-span-2" label="Options (comma-separated)" value={f.options} onChange={(e) => updateField(i, { options: e.target.value })} placeholder="e.g. Low, Medium, High" />
                  )}
                  {FIELD_TYPES_WITH_PATTERN.has(f.type) && (
                    <Field containerClassName="md:col-span-2" label="Validation pattern (regex)" value={f.pattern} onChange={(e) => updateField(i, { pattern: e.target.value })} placeholder="^[A-Za-z0-9]+$" />
                  )}
                  <Checkbox label="Required" checked={f.required} onChange={(v) => updateField(i, { required: v })} className="md:col-span-2" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
      </div>
      <FormPreview name={name} description={description} fields={fields} />
      </div>
    </PaneForm>
  );
}
