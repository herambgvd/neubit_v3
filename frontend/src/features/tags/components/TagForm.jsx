"use client";

// Create / edit form for a tag — name, color (native picker + hex text + preset
// swatches), description and (edit-only) active toggle. Owns its own local form
// state + save mutation; calls onSaved(saved) / onCancel back to the parent.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { tags as tagsApi } from "@/lib/api/tags";
import { DEFAULT_COLOR, HEX_RE, SWATCHES } from "../constants";

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
    <form noValidate onSubmit={submit} className="flex flex-col flex-1 min-h-0">
      <header className="flex items-center justify-between px-6 py-5 border-b border-card-border">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-white" style={{ background: HEX_RE.test(color) ? color : DEFAULT_COLOR }}>
            <Icon icon="heroicons:tag" className="text-xl" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{isEdit ? `Edit ${tag.name}` : "Create tag"}</h2>
            <p className="text-xs text-muted mt-0.5">
              {isEdit ? "Update this label's name, color or description." : "Add a new cross-cutting label."}
            </p>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-base" />
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 space-y-5">
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
                className="h-10 w-16 rounded-md border border-field cursor-pointer bg-transparent"
              />
              <input
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  clearErr("color");
                }}
                className={`h-10 flex-1 rounded-md border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted ${errors.color ? "!border-red-500" : ""}`}
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
                    color?.toUpperCase() === c ? "border-foreground scale-110" : "border-card-border"
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
            <label className="flex items-center gap-2 h-10 px-3 rounded-lg border border-field bg-transparent text-sm cursor-pointer w-fit">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              <span className="text-foreground">Active</span>
            </label>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="success" disabled={saving.isPending}>
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create tag"}
        </Button>
      </div>
    </form>
  );
}
