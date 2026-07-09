"use client";

// Add / edit a tiering rule — move recordings from a source pool to a target
// pool once they age past N hours (hot local → cold S3). Contract fields:
// name, source_pool_id, target_pool_id, after_age_hours, enabled.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";

// Common age presets → hours, for the quick-pick chips.
const AGE_PRESETS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

function hydrate(rule) {
  return {
    name: rule?.name || "",
    source_pool_id: rule?.source_pool_id || "",
    target_pool_id: rule?.target_pool_id || "",
    after_age_hours: rule?.after_age_hours ?? 168,
    enabled: rule?.enabled ?? true,
  };
}

export default function TierRuleModal({ rule, pools = [], onClose, onSuccess }) {
  const isEdit = !!rule;
  const qc = useQueryClient();
  const [form, setForm] = useState(() => hydrate(rule));
  const [errors, setErrors] = useState({});
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const poolOpt = (extraFilter) => [
    { value: "", label: "Select…" },
    ...pools.filter(extraFilter || (() => true)).map((p) => ({ value: p.id, label: p.name })),
  ];

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        source_pool_id: form.source_pool_id,
        target_pool_id: form.target_pool_id,
        after_age_hours: Number(form.after_age_hours) || 24,
        enabled: !!form.enabled,
      };
      return isEdit ? vms.storage.tierRules.update(rule.id, body) : vms.storage.tierRules.create(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Rule updated" : "Rule created");
      qc.invalidateQueries({ queryKey: ["vms-tier-rules"] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const submit = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = "Required";
    if (!form.source_pool_id) errs.source_pool_id = "Required";
    if (!form.target_pool_id) errs.target_pool_id = "Required";
    if (form.source_pool_id && form.source_pool_id === form.target_pool_id)
      errs.target_pool_id = "Must differ from source";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit tier rule — ${rule.name}` : "New tier rule"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create rule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Rule name"
          required
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="e.g. Hot → cold after a week"
          error={errors.name}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field
            as="select"
            label="Source pool"
            required
            value={form.source_pool_id}
            onChange={(e) => set({ source_pool_id: e.target.value })}
            options={poolOpt()}
            error={errors.source_pool_id}
          />
          <Field
            as="select"
            label="Target pool"
            required
            value={form.target_pool_id}
            onChange={(e) => set({ target_pool_id: e.target.value })}
            options={poolOpt((p) => p.id !== form.source_pool_id)}
            error={errors.target_pool_id}
          />
        </div>
        <div>
          <Field
            label="Move after (hours)"
            type="number"
            required
            value={form.after_age_hours}
            onChange={(e) => set({ after_age_hours: e.target.value })}
            hint="Recordings older than this move source → target."
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {AGE_PRESETS.map((p) => (
              <button
                key={p.hours}
                type="button"
                onClick={() => set({ after_age_hours: p.hours })}
                className={`rounded-md border px-2 py-1 text-xs transition ${
                  Number(form.after_age_hours) === p.hours
                    ? "border-foreground text-foreground"
                    : "border-card-border text-muted hover:bg-hover"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <Toggle checked={!!form.enabled} onChange={(v) => set({ enabled: v })} />
          Enabled
        </label>
      </div>
    </Modal>
  );
}
