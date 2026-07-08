"use client";

// Builder for a dynamic form (attached to transitions). Name/description via the
// shared Field; each field is an editable, collapsible card with label + type +
// required + placeholder + default + help text + validation regex + options, and
// up/down reorder. Serialises to the backend FormFieldSchema shape on save
// (options → [{value,label}], validation → { required, pattern }, help_text,
// default_value, order). The right column is the live FormPreview.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field, FieldLabel, fieldClass } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import FormPreview from "./FormPreview";

// Form field kinds the builder can create (mirrors backend FieldType enum).
const FIELD_TYPES = ["text", "textarea", "number", "email", "phone", "date", "datetime", "select", "radio", "multiselect", "checkbox", "boolean", "rating", "file"];
// Types that own an editable option list.
const FIELD_TYPES_WITH_OPTIONS = new Set(["select", "radio", "multiselect"]);
// Types that accept a validation regex (only meaningful on strings).
const FIELD_TYPES_WITH_PATTERN = new Set(["text", "textarea", "email", "phone", "number"]);

const blankField = () => ({
  label: "",
  type: "text",
  required: false,
  options: "",
  placeholder: "",
  default_value: "",
  help_text: "",
  pattern: "",
  _collapsed: false,
});

// Backend field → editor row (options list → comma string; validation → flat).
function hydrateField(f) {
  return {
    label: f.label || "",
    type: f.type || "text",
    required: !!f.validation?.required,
    options: (f.options || []).map((o) => o.label ?? o.value ?? "").join(", "),
    placeholder: f.placeholder || "",
    default_value: f.default_value ?? "",
    help_text: f.help_text || "",
    pattern: f.validation?.pattern || "",
    _collapsed: false,
  };
}

export default function FormBuilder({ form, onCancel, onSaved }) {
  const isEdit = !!form;
  const [name, setName] = useState(form?.name || "");
  const [description, setDescription] = useState(form?.description || "");
  const [isActive, setIsActive] = useState(form?.is_active !== false);
  const [fields, setFields] = useState(
    Array.isArray(form?.fields) && form.fields.length ? form.fields.map(hydrateField) : [blankField()],
  );
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.forms.update(form.form_id, body) : wfApi.forms.create(body)),
    onSuccess: () => { toast.success(isEdit ? "Form updated" : "Form created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateField = (i, patch) => setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, blankField()]);
  const removeField = (i) => setFields((fs) => fs.filter((_, idx) => idx !== i));
  const moveField = (from, to) =>
    setFields((fs) => {
      if (to < 0 || to >= fs.length || from === to) return fs;
      const next = [...fs];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    const clean = fields.filter((f) => f.label.trim());
    if (clean.length === 0) next.fields = "Add at least one field";
    if (Object.keys(next).length) { setErrors(next); return; }
    const payloadFields = clean.map((f, i) => {
      const opts = FIELD_TYPES_WITH_OPTIONS.has(f.type)
        ? f.options.split(",").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
        : [];
      const validation = { required: !!f.required };
      if (FIELD_TYPES_WITH_PATTERN.has(f.type) && f.pattern.trim()) validation.pattern = f.pattern.trim();
      const out = {
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
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${form.name}` : "New form"}</h4>
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
          <label className="text-xs font-medium uppercase tracking-wide text-muted">Fields</label>
          <button type="button" onClick={addField} className="text-xs text-blue-500 hover:underline">+ Add field</button>
        </div>
        {errors.fields && <p className="mb-2 text-xs text-red-500">{errors.fields}</p>}
        <div className="space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="rounded-lg border border-card-border bg-card">
              <header className="flex items-center gap-2 px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => updateField(i, { _collapsed: !f._collapsed })}
                  title={f._collapsed ? "Expand" : "Collapse"}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"
                >
                  <Icon icon={f._collapsed ? "heroicons-outline:chevron-right" : "heroicons-outline:chevron-down"} className="text-sm" />
                </button>
                <span className="text-xs font-semibold text-foreground">Field {i + 1}</span>
                <span className="text-xs text-muted truncate">{f.label || "(unnamed)"}</span>
                <span className="ml-auto inline-flex items-center gap-0.5">
                  <button type="button" onClick={() => moveField(i, i - 1)} disabled={i === 0} title="Move up" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed">
                    <Icon icon="heroicons-outline:chevron-up" className="text-sm" />
                  </button>
                  <button type="button" onClick={() => moveField(i, i + 1)} disabled={i === fields.length - 1} title="Move down" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed">
                    <Icon icon="heroicons-outline:chevron-down" className="text-sm" />
                  </button>
                  <button type="button" onClick={() => removeField(i)} title="Delete field" className="inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500">
                    <Icon icon="heroicons-outline:x-mark" className="text-sm" />
                  </button>
                </span>
              </header>

              {!f._collapsed && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 border-t border-card-border p-2.5">
                  <Field label="Label" required value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Field label" />
                  <div>
                    <FieldLabel>Type</FieldLabel>
                    <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value })} className={fieldClass}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t} className="bg-card">{titleize(t)}</option>)}
                    </select>
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
                  <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer md:col-span-2">
                    <input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required
                  </label>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create form"}</Button>
      </div>
    </form>
      <FormPreview name={name} description={description} fields={fields} />
    </div>
  );
}
