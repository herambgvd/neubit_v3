"use client";

// Create/edit form for a SOP (name, default priority, SLA, description, active).
// Fills the detail pane when the SopsTab is in create/edit mode.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Checkbox } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize, idOf } from "@/lib/format";
import { PRIORITIES } from "../../constants";
import { workflow as wfApi } from "../../api";
import { PaneForm } from "@/components/console";

export default function SopForm({ sop, onCancel, onSaved }: any) {
  const isEdit = !!sop;
  const [name, setName] = useState(sop?.name || "");
  const [description, setDescription] = useState(sop?.description || "");
  const [priority, setPriority] = useState(sop?.default_priority || "medium");
  const [slaHours, setSlaHours] = useState(sop?.sla_hours ?? "");
  const [tagsCsv, setTagsCsv] = useState((sop?.tags || []).join(", "));
  const [eventCsv, setEventCsv] = useState((sop?.trigger_event_types || []).join(", "));
  const [escalationCsv, setEscalationCsv] = useState(JSON.stringify(sop?.escalation_rules || [], null, 2));
  const [isActive, setIsActive] = useState(sop?.is_active !== false);
  const [errors, setErrors] = useState<any>({});

  const saving = useMutation<any, any, any>({
    mutationFn: (body: any) => (isEdit ? wfApi.sops.update(idOf(sop, "id", "sop_id"), body) : wfApi.sops.create(body)),
    onSuccess: (saved) => { toast.success(isEdit ? "SOP updated" : "SOP created"); onSaved(saved); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setErrors({ name: "Name is required" }); return; }
    let escalation_rules: any[] = [];
    try {
      const v = JSON.parse(escalationCsv || "[]");
      if (Array.isArray(v)) escalation_rules = v;
    } catch {
      setErrors({ escalation_rules: "Escalation rules must be valid JSON" });
      toast.error("Escalation rules must be valid JSON");
      return;
    }
    saving.mutate({
      name: name.trim(),
      description: description.trim() || null,
      default_priority: priority,
      sla_hours: slaHours === "" ? null : Number(slaHours),
      tags: tagsCsv.split(",").map((s) => s.trim()).filter(Boolean),
      trigger_event_types: eventCsv.split(",").map((s) => s.trim()).filter(Boolean),
      escalation_rules,
      is_active: isActive,
    });
  }

  return (
    <PaneForm
      title={isEdit ? `Edit ${sop.name}` : "Create SOP"}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create SOP"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
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
        <Field
          label="Tags (comma-separated)"
          value={tagsCsv}
          onChange={(e) => setTagsCsv(e.target.value)}
          placeholder="alarm, after-hours"
        />
        <Field
          label="Trigger event types (comma-separated)"
          value={eventCsv}
          onChange={(e) => setEventCsv(e.target.value)}
          placeholder="vms.camera.motion"
        />
        <div className="md:col-span-2">
          <Field
            as="textarea"
            rows={6}
            label="Escalation rules (JSON)"
            value={escalationCsv}
            onChange={(e) => { setEscalationCsv(e.target.value); if (errors.escalation_rules) setErrors({}); }}
            error={errors.escalation_rules}
            placeholder='[{ "after_hours": 2, "to_priority": "high", "notify_role_ids": [] }]'
            className="font-mono text-xs"
          />
          <p className="mt-1 text-[11px] text-nb-faint">
            Array of objects: <code className="font-mono">{`{ after_hours, to_priority, notify_role_ids }`}</code>
          </p>
        </div>
        <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
      </div>
    </PaneForm>
  );
}
