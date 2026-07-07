"use client";

// Create/edit form for a SOP (name, default priority, SLA, description, active).
// Fills the detail pane when the SopsTab is in create/edit mode.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize, idOf } from "@/lib/format";
import { PRIORITIES } from "../../constants";
import { workflow as wfApi } from "../../api";

export default function SopForm({ sop, onCancel, onSaved }) {
  const isEdit = !!sop;
  const [name, setName] = useState(sop?.name || "");
  const [description, setDescription] = useState(sop?.description || "");
  const [priority, setPriority] = useState(sop?.default_priority || "medium");
  const [slaHours, setSlaHours] = useState(sop?.sla_hours ?? "");
  const [isActive, setIsActive] = useState(sop?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.sops.update(idOf(sop, "id", "sop_id"), body) : wfApi.sops.create(body)),
    onSuccess: (saved) => { toast.success(isEdit ? "SOP updated" : "SOP created"); onSaved(saved); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setErrors({ name: "Name is required" }); return; }
    saving.mutate({
      name: name.trim(),
      description: description.trim() || null,
      default_priority: priority,
      sla_hours: slaHours === "" ? null : Number(slaHours),
      is_active: isActive,
    });
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col flex-1 min-h-0">
      <header className="px-6 py-5 border-b border-card-border">
        <h2 className="text-lg font-semibold text-foreground">{isEdit ? `Edit ${sop.name}` : "Create SOP"}</h2>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field
          containerClassName="md:col-span-2"
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); if (errors.name) setErrors({}); }}
          placeholder="e.g. Fire alarm response"
          error={errors.name}
        />
        <Field
          as="select"
          label="Default priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          options={PRIORITIES.map((p) => ({ value: p, label: titleize(p) }))}
        />
        <Field
          type="number"
          min={0}
          label="SLA (hours)"
          value={slaHours}
          onChange={(e) => setSlaHours(e.target.value)}
          placeholder="Optional"
        />
        <Field
          as="textarea"
          rows={3}
          containerClassName="md:col-span-2"
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
        />
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
      </div>
      <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-card-border">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="success" disabled={saving.isPending}>{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create SOP"}</Button>
      </div>
    </form>
  );
}
