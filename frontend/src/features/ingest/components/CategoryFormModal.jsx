"use client";

// Category create / edit modal. Presentational shell via kit <Modal>; the form
// fields use the shared <Field>.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";

export default function CategoryFormModal({ category, onCancel, onSaved }) {
  const isEdit = !!category;
  const [name, setName] = useState(category?.name || "");
  const [description, setDescription] = useState(category?.description || "");
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => {
      const id = category?.id ?? category?.category_id;
      return isEdit ? ingestApi.categories.update(id, body) : ingestApi.categories.create(body);
    },
    onSuccess: (saved) => {
      toast.success(isEdit ? "Category updated" : "Category created");
      onSaved(saved);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    saving.mutate({ name: name.trim(), description: description.trim() || null });
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={isEdit ? `Edit ${category?.name}` : "Create category"}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" form="ingest-category-form" variant="success" disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </Button>
        </>
      }
    >
      <form id="ingest-category-form" noValidate onSubmit={submit} className="space-y-4">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) setErrors({});
          }}
          placeholder="e.g. Access Control"
          error={errors.name}
        />
        <Field
          as="textarea"
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
        />
      </form>
    </Modal>
  );
}
