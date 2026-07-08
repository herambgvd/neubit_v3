"use client";

// Live preview pane for the form being built. Renders the current field defs as
// a real (interactive) form that updates as the builder rows change. "Test
// submit" runs client-side validation and shows the resulting form_data — no API.
//
// Accepts the FormBuilder editor rows ({ label, type, required, options: comma
// string, placeholder }) and normalises them to the renderer/validation field
// shape ({ id, label, type, options:[{value,label}], validation:{required} }).
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import FormRenderer from "./FormRenderer";
import FormSubmitTestModal from "./FormSubmitTestModal";

const FIELDS_WITH_OPTIONS = new Set(["select", "radio"]);

const slug = (s, i) =>
  ((s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `field_${i + 1}`);

// Builder rows → renderer fields, with unique ids.
export function normalizeFields(rows) {
  const seen = new Map();
  return (rows || [])
    .filter((f) => (f.label || "").trim())
    .map((f, i) => {
      const base = slug(f.label, i);
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      const id = n === 0 ? base : `${base}_${n + 1}`;
      const options = FIELDS_WITH_OPTIONS.has(f.type)
        ? String(f.options || "").split(",").map((s) => s.trim()).filter(Boolean).map((v) => ({ value: v, label: v }))
        : [];
      return {
        id,
        label: f.label.trim(),
        type: f.type,
        placeholder: f.placeholder || "",
        options,
        validation: { required: !!f.required, pattern: f.pattern || undefined },
      };
    });
}

export default function FormPreview({ name, description, fields }) {
  const [values, setValues] = useState({});
  const [showSubmit, setShowSubmit] = useState(false);

  const previewFields = useMemo(() => normalizeFields(fields), [fields]);
  const update = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  return (
    <div className="rounded-lg border border-card-border bg-card">
      <header className="flex items-center gap-2 border-b border-card-border px-4 py-2.5">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-violet-500/10 text-violet-500">
          <Icon icon="heroicons-outline:eye" className="text-sm" />
        </span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Live preview</span>
      </header>
      <div className="p-4">
        <div className="rounded-lg border border-card-border bg-hover/30 p-4">
          <h3 className="text-base font-semibold text-foreground">{name?.trim() || "Untitled form"}</h3>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}

          {previewFields.length === 0 ? (
            <p className="mt-5 text-sm text-muted">Add fields to see the preview.</p>
          ) : (
            <form
              className="mt-4 space-y-4"
              onSubmit={(e) => { e.preventDefault(); setShowSubmit(true); }}
            >
              {previewFields.map((f) => (
                <FormRenderer key={f.id} field={f} value={values[f.id]} onChange={(v) => update(f.id, v)} />
              ))}
              <Button type="submit" icon="heroicons-outline:paper-airplane" className="!px-3 !py-1.5 text-xs">Test submit</Button>
            </form>
          )}
        </div>
      </div>

      <FormSubmitTestModal
        open={showSubmit}
        onClose={() => setShowSubmit(false)}
        fields={previewFields}
        values={values}
      />
    </div>
  );
}
