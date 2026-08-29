"use client";

// Create / edit form for a tag — name, color (native picker + hex text + preset
// swatches), description and (edit-only) active toggle. Owns its own local form
// state + save mutation; calls onSaved(saved) / onCancel back to the parent.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { ActionButton, QuietButton, PaneForm } from "@/components/console";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";
import { DEFAULT_COLOR, HEX_RE, SWATCHES } from "../constants";
import { checkboxClass } from "@/components/ui/kit";

export default function TagForm({ tag, onCancel, onSaved }) {
  const isEdit = !!tag;
  const [name, setName] = useState(tag?.name || "");
  const [color, setColor] = useState(tag?.color || DEFAULT_COLOR);
  const [description, setDescription] = useState(tag?.description || "");
  const [isActive, setIsActive] = useState(tag?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? tagsApi.update(tag.tag_id, body) : tagsApi.create(body)),
    onSuccess: (saved) => {
      setErrors({});
      toast.success(isEdit ? "Tag updated" : "Tag created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!HEX_RE.test(color)) next.color = "Color must be a 6-digit hex (e.g. #3B82F6)";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      color,
      description: description.trim() || null,
    };
    if (isEdit) body.is_active = isActive;
    saving.mutate(body);
  }

  const clearErr = (key) => errors[key] && setErrors((p) => ({ ...p, [key]: undefined }));

  return (
    <PaneForm
      title={isEdit ? `Edit ${tag.name}` : "Create tag"}
      subtitle={isEdit ? "Update this label's name, color or description." : "Add a new cross-cutting label."}
      onSubmit={submit}
      footer={
        <>
          <QuietButton onClick={onCancel}>Cancel</QuietButton>
          <ActionButton type="submit" icon="heroicons-outline:check" disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create tag"}
          </ActionButton>
        </>
      }
    >
        <div className="max-w-lg space-y-5">
          <Field
            label="Name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              clearErr("name");
            }}
            placeholder="Enter tag name"
            error={errors.name}
          />

          <div>
            <FieldLabel>Color</FieldLabel>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="color"
                value={HEX_RE.test(color) ? color : DEFAULT_COLOR}
                onChange={(e) => {
                  setColor(e.target.value);
                  clearErr("color");
                }}
                className="h-10 w-16 rounded-md border border-nb-line cursor-pointer bg-transparent"
              />
              <input
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  clearErr("color");
                }}
                className={`h-10 flex-1 rounded-md border border-nb-line bg-transparent px-3 text-sm font-mono text-nb-ink outline-hidden focus:border-nb-teal ${errors.color ? "!border-red-500" : ""}`}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => {
                    setColor(c);
                    clearErr("color");
                  }}
                  className={`h-6 w-6 rounded-full border transition ${
                    color?.toUpperCase() === c ? "border-nb-ink scale-110" : "border-nb-line"
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
            {errors.color && <p className="mt-1 text-xs text-red-500">{errors.color}</p>}
          </div>

          <Field
            label="Description"
            as="textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tag description (optional)"
          />

          {isEdit && (
            <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-nb-line bg-transparent text-sm cursor-pointer w-fit">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className={checkboxClass} />
              <span className="text-nb-ink">Active</span>
            </label>
          )}
        </div>
    </PaneForm>
  );
}
