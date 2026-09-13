"use client";

// Create/edit form for a SOP (name, default priority, SLA, description, active).
// Fills the detail pane when the SopsTab is in create/edit mode.
import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Checkbox, Input, Select } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { randomId } from "@/lib/random";
import { titleize } from "@/lib/format";
import { PRIORITIES, isPriority } from "../../constants";
import { workflow as wfApi } from "../../api";
import type { CreateSopRequest, EscalationRule, SopPublic } from "../../types";
import { PaneForm, QuietButton, RowAction } from "@/components/console";

type ErrorKey = "name" | "escalation_rules";

/** An escalation rule while it is being edited. The stored shape has no id, so
 *  `_key` is what keeps a row's inputs with the row when one above it is
 *  removed; it is stripped on submit. */
type RuleDraft = EscalationRule & { _key: string };

const asDraft = (r: EscalationRule): RuleDraft => ({ ...r, _key: randomId() });

export interface SopFormProps {
  /** The SOP being edited; null creates one. */
  sop: SopPublic | null;
  onCancel: () => void;
  onSaved: (saved: SopPublic) => void;
}

export default function SopForm({ sop, onCancel, onSaved }: SopFormProps) {
  const isEdit = !!sop;
  const [name, setName] = useState(sop?.name || "");
  const [description, setDescription] = useState(sop?.description || "");
  const [priority, setPriority] = useState<string>(sop?.priority || "medium");
  const [slaHours, setSlaHours] = useState<string | number>(sop?.sla_hours ?? "");
  const [tagsCsv, setTagsCsv] = useState((sop?.tags || []).join(", "));
  const [eventCsv, setEventCsv] = useState((sop?.trigger_event_types || []).join(", "));
  // The rules themselves. A malformed JSON string cannot exist here, so the
  // "must be valid JSON" error it used to raise cannot either.
  const [rules, setRules] = useState<RuleDraft[]>(() => (sop?.escalation_rules || []).map(asDraft));
  const patchRule = (i: number, patch: Partial<EscalationRule>) =>
    setRules((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const [isActive, setIsActive] = useState(sop?.is_active !== false);
  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({});

  const saving = useMutation({
    mutationFn: (body: CreateSopRequest) => (sop ? wfApi.sops.update(sop.sop_id, body) : wfApi.sops.create(body)),
    onSuccess: (saved) => { toast.success(isEdit ? "SOP updated" : "SOP created"); onSaved(saved); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) { setErrors({ name: "Name is required" }); return; }
    saving.mutate({
      name: name.trim(),
      description: description.trim() || null,
      priority: isPriority(priority) ? priority : undefined,
      sla_hours: slaHours === "" ? null : Number(slaHours),
      tags: tagsCsv.split(",").map((s) => s.trim()).filter(Boolean),
      trigger_event_types: eventCsv.split(",").map((s) => s.trim()).filter(Boolean),
      // Sorted, so the sweep reads them in the order they fire and a reader
      // sees the ladder rather than the order they were typed in.
      escalation_rules: [...rules].sort((a, b) => a.after_hours - b.after_hours).map(({ _key, ...r }) => r),
      is_active: isActive,
    });
  }

  return (
    <PaneForm
      title={sop ? `Edit ${sop.name}` : "Create SOP"}
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
          {/* Rules, not JSON. The escalation sweep reads these every minute and
              raises an incident's priority when it has sat too long — a real
              behaviour that an operator had to hand-write as
              `[{"after_hours":2,"to_priority":"high","notify_role_ids":[]}]`,
              where a stray comma silently meant "no escalation at all". */}
          <FieldLabel>Escalation</FieldLabel>
          <p className="mb-2 text-[11px] text-nb-faint">
            Raise the priority when an incident has been open this long. Checked every
            minute; a rule only ever raises, never lowers.
          </p>
          <div className="space-y-2">
            {rules.length === 0 && (
              <p className="rounded-[10px] border border-dashed border-nb-line px-3 py-3 text-center text-[11.5px] text-nb-faint">
                No escalation — an incident keeps the priority it was created with.
              </p>
            )}
            {rules.map((r, i) => (
              <div key={r._key} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-nb-line bg-[rgba(10,18,40,.5)] px-3 py-2">
                <span className="text-[11.5px] text-nb-soft">After</span>
                <Input
                  type="number"
                  min={0.25}
                  step={0.25}
                  aria-label={`Hours before rule ${i + 1}`}
                  value={r.after_hours}
                  onChange={(e) => patchRule(i, { after_hours: Number(e.target.value) })}
                  className="!h-8 w-24 !py-1"
                  wrapperClassName="shrink-0"
                />
                <span className="text-[11.5px] text-nb-soft">hours, raise to</span>
                <Select
                  ariaLabel={`Priority for rule ${i + 1}`}
                  value={r.to_priority}
                  onChange={(e) => patchRule(i, { to_priority: e.target.value as EscalationRule["to_priority"] })}
                  options={PRIORITIES.map((p) => ({ value: p, label: titleize(p) }))}
                  className="!h-8 !py-1"
                />
                <RowAction
                  icon="heroicons-outline:trash"
                  title={`Remove rule ${i + 1}`}
                  tone="danger"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  className="ml-auto"
                />
              </div>
            ))}
            <QuietButton
              icon="heroicons:plus"
              className="!py-1.5 !text-xs"
              onClick={() => setRules([...rules, asDraft({ after_hours: 2, to_priority: "high", notify_role_ids: [] })])}
            >
              Add escalation
            </QuietButton>
          </div>
        </div>
        <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
      </div>
    </PaneForm>
  );
}
