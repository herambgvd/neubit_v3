"use client";

// Builder for a dynamic form (attached to transitions). Name/description via the
// shared Field; the repeatable field editor rows (label + type + required +
// options) stay bespoke (compact inline controls). Serialises to the backend
// FormFieldSchema shape on save.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";

// Form field kinds the builder can create (mirrors backend FieldType enum).
const FIELD_TYPES = ["text", "textarea", "number", "email", "phone", "date", "datetime", "select", "radio", "checkbox", "boolean", "file"];
const FIELD_TYPES_WITH_OPTIONS = new Set(["select", "radio"]);

export default function FormBuilder({ form, onCancel, onSaved }) {
  const isEdit = !!form;
  const [name, setName] = useState(form?.name || "");
  const [description, setDescription] = useState(form?.description || "");
  const [isActive, setIsActive] = useState(form?.is_active !== false);
  const [fields, setFields] = useState(
    Array.isArray(form?.fields) && form.fields.length
      ? form.fields.map((f) => ({
          label: f.label || "",
          type: f.type || "text",
          required: !!(f.validation?.required),
          options: (f.options || []).map((o) => o.label ?? o.value ?? "").join(", "),
          placeholder: f.placeholder || "",
        }))
      : [{ label: "", type: "text", required: false, options: "", placeholder: "" }],
  );
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.forms.update(form.form_id, body) : wfApi.forms.create(body)),
    onSuccess: () => { toast.success(isEdit ? "Form updated" : "Form created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateField = (i, patch) => setFields((fs) => fs.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, { label: "", type: "text", required: false, options: "", placeholder: "" }]);
  const removeField = (i) => setFields((fs) => fs.filter((_, idx) => idx !== i));

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
      return {
        id: `f_${i}`,
        label: f.label.trim(),
        type: f.type,
        placeholder: f.placeholder.trim() || null,
        options: opts,
        validation: { required: !!f.required },
        order: i,
      };
    });
    saving.mutate({ name: name.trim(), description: description.trim() || null, fields: payloadFields, is_active: isActive });
  }

  return (
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
            <div key={i} className="rounded-lg border border-card-border bg-card p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} placeholder="Field label" className="h-9 flex-1 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
                <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value })} className="h-9 rounded-lg border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted">
                  {FIELD_TYPES.map((t) => <option key={t} value={t} className="bg-card">{titleize(t)}</option>)}
                </select>
                <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer whitespace-nowrap"><input type="checkbox" checked={f.required} onChange={(e) => updateField(i, { required: e.target.checked })} /> Required</label>
                <button type="button" onClick={() => removeField(i)} className="h-9 w-9 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
              </div>
              {FIELD_TYPES_WITH_OPTIONS.has(f.type) && (
                <input value={f.options} onChange={(e) => updateField(i, { options: e.target.value })} placeholder="Options (comma-separated), e.g. Low, Medium, High" className="h-9 w-full rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
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
  );
}
