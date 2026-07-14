"use client";

// LinkageRuleModal — create / edit a linkage rule. Sections: identity (name,
// description, active), trigger (event-type + filter: severity/zone), camera scope
// (all / pick cameras / pick groups), actions builder, cooldown, and schedule.
// Serializes to the backend shape (camera_scope {all|camera_ids|group_ids},
// trigger_filter {severity?|min_severity?|zone?}, actions[{type,config}],
// schedule {mon:[[..]]}). CRUD via vms.linkage.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";

import { Input, Modal, Select, Textarea, Toggle } from "@/components/ui/kit";
import { asItems } from "@/lib/format";
import { vms } from "../api";
import { EVENT_TYPE_FILTERS } from "../constants";
import LinkageActionsBuilder from "./LinkageActionsBuilder";
import LinkageScheduleEditor from "./LinkageScheduleEditor";

const SEVERITY_MIN_OPTIONS = [
  { value: "", label: "Any severity" },
  { value: "info", label: "Info and above" },
  { value: "warning", label: "Warning and above" },
  { value: "critical", label: "Critical only" },
];

// Trigger event-type list (drop the "All types" sentinel — a rule triggers on ONE type).
const TRIGGER_TYPE_OPTIONS = EVENT_TYPE_FILTERS.filter((o) => o.value).map((o) => ({
  value: o.value,
  label: o.label,
}));

const SCOPE_MODES = [
  { value: "all", label: "Any camera (the event's own)" },
  { value: "camera_ids", label: "Specific cameras" },
  { value: "group_ids", label: "Camera groups" },
];

// Derive the editor form from a rule row (or defaults for a new rule).
function toForm(rule) {
  const scope = rule?.camera_scope || {};
  let scopeMode = "all";
  if (Array.isArray(scope.camera_ids) && scope.camera_ids.length) scopeMode = "camera_ids";
  else if (Array.isArray(scope.group_ids) && scope.group_ids.length) scopeMode = "group_ids";
  const flt = rule?.trigger_filter || {};
  return {
    name: rule?.name || "",
    description: rule?.description || "",
    is_active: rule?.is_active ?? true,
    trigger_event_type: rule?.trigger_event_type || "motion",
    min_severity: flt.min_severity || flt.severity || "",
    zone: flt.zone || "",
    scopeMode,
    camera_ids: Array.isArray(scope.camera_ids) ? scope.camera_ids : [],
    group_ids: Array.isArray(scope.group_ids) ? scope.group_ids : [],
    actions: Array.isArray(rule?.actions) ? rule.actions : [],
    cooldown_seconds: rule?.cooldown_seconds ?? 0,
    schedule: rule?.schedule || {},
  };
}

// Serialize the form → the backend LinkageRuleCreate/Update body.
function toBody(f) {
  const trigger_filter = {};
  if (f.min_severity) trigger_filter.min_severity = f.min_severity;
  if (f.zone) trigger_filter.zone = f.zone.trim();

  let camera_scope = { all: true };
  if (f.scopeMode === "camera_ids") camera_scope = { camera_ids: f.camera_ids };
  else if (f.scopeMode === "group_ids") camera_scope = { group_ids: f.group_ids };

  return {
    name: f.name.trim(),
    description: f.description?.trim() || null,
    is_active: f.is_active,
    trigger_event_type: f.trigger_event_type,
    trigger_filter,
    camera_scope,
    actions: f.actions.map((a) => ({ type: a.type, config: a.config || {} })),
    cooldown_seconds: Number(f.cooldown_seconds) || 0,
    schedule: f.schedule || {},
  };
}

export default function LinkageRuleModal({ open, rule, onClose, onSave, saving = false, error }) {
  const [form, setForm] = useState(() => toForm(rule));

  useEffect(() => {
    if (open) setForm(toForm(rule));
  }, [open, rule]);

  const camerasQ = useQuery({
    queryKey: ["vms-cameras", "linkage-scope"],
    queryFn: () => vms.cameras.list({ limit: 500 }),
    enabled: open,
    staleTime: 60_000,
  });
  const groupsQ = useQuery({
    queryKey: ["vms-groups", "linkage-scope"],
    queryFn: () => vms.groups.list({ limit: 500 }),
    enabled: open,
    staleTime: 60_000,
  });
  const cameras = useMemo(() => asItems(camerasQ.data), [camerasQ.data]);
  const groups = useMemo(() => asItems(groupsQ.data), [groupsQ.data]);

  const patch = (p) => setForm((f) => ({ ...f, ...p }));
  const toggleIn = (list, id) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

  const nameValid = form.name.trim().length > 0;
  const scopeValid =
    form.scopeMode === "all" ||
    (form.scopeMode === "camera_ids" && form.camera_ids.length) ||
    (form.scopeMode === "group_ids" && form.group_ids.length);
  const canSave = nameValid && scopeValid && form.trigger_event_type;

  const submit = () => {
    if (!canSave) return;
    onSave?.(toBody(form));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? "Edit linkage rule" : "New linkage rule"}
      wide
      footer={
        <div className="flex items-center justify-between gap-3">
          {error ? (
            <span className="text-[11px] text-red-500">{error}</span>
          ) : (
            <span className="text-[11px] text-muted">
              {form.actions.length} action{form.actions.length === 1 ? "" : "s"}
            </span>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-card-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-hover hover:text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSave || saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs font-semibold text-background hover:opacity-90 disabled:opacity-40"
            >
              {saving && <Icon icon="svg-spinners:180-ring" className="text-sm" />}
              {rule ? "Save changes" : "Create rule"}
            </button>
          </div>
        </div>
      }
    >
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        {/* Identity */}
        <Section title="Rule">
          <div className="grid grid-cols-2 gap-3">
            <Input label="Name" value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Record on lobby motion" />
            <div className="flex items-end gap-2 pb-1">
              <Toggle checked={form.is_active} onChange={(v) => patch({ is_active: v })} />
              <span className="text-xs text-muted">{form.is_active ? "Active" : "Inactive"}</span>
            </div>
          </div>
          <Textarea label="Description" value={form.description} onChange={(e) => patch({ description: e.target.value })} rows={2} placeholder="Optional notes" />
        </Section>

        {/* Trigger */}
        <Section title="Trigger">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Event type">
              <Select
                value={form.trigger_event_type}
                onChange={(e) => patch({ trigger_event_type: e.target.value })}
                options={TRIGGER_TYPE_OPTIONS}
                className="!h-9 !py-1.5"
              />
            </Field>
            <Field label="Minimum severity">
              <Select
                value={form.min_severity}
                onChange={(e) => patch({ min_severity: e.target.value })}
                options={SEVERITY_MIN_OPTIONS}
                className="!h-9 !py-1.5"
              />
            </Field>
            <Input label="Zone (optional)" value={form.zone} onChange={(e) => patch({ zone: e.target.value })} placeholder="e.g. north" />
          </div>
        </Section>

        {/* Camera scope */}
        <Section title="Camera scope">
          <Field label="Applies to">
            <Select value={form.scopeMode} onChange={(e) => patch({ scopeMode: e.target.value })} options={SCOPE_MODES} className="!h-9 !py-1.5" />
          </Field>
          {form.scopeMode === "camera_ids" && (
            <PickList
              items={cameras.map((c) => ({ id: c.id, label: c.name }))}
              selected={form.camera_ids}
              onToggle={(id) => patch({ camera_ids: toggleIn(form.camera_ids, id) })}
              empty="No cameras"
              loading={camerasQ.isLoading}
            />
          )}
          {form.scopeMode === "group_ids" && (
            <PickList
              items={groups.map((g) => ({ id: g.id, label: g.name }))}
              selected={form.group_ids}
              onToggle={(id) => patch({ group_ids: toggleIn(form.group_ids, id) })}
              empty="No camera groups"
              loading={groupsQ.isLoading}
            />
          )}
        </Section>

        {/* Actions */}
        <Section title="Actions">
          <LinkageActionsBuilder actions={form.actions} onChange={(actions) => patch({ actions })} />
        </Section>

        {/* Cooldown + schedule */}
        <Section title="Rate limit & schedule">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Cooldown (seconds)"
              type="number"
              min={0}
              value={form.cooldown_seconds}
              onChange={(e) => patch({ cooldown_seconds: e.target.value })}
              hint="Suppress re-firing within this window (0 = none)"
            />
          </div>
          <div className="mt-2">
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">Active window</label>
            <LinkageScheduleEditor value={form.schedule} onChange={(schedule) => patch({ schedule })} />
          </div>
        </Section>
      </div>
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</h4>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">{label}</label>
      {children}
    </div>
  );
}

function PickList({ items, selected, onToggle, empty, loading }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted">
        <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading…
      </div>
    );
  }
  if (!items.length) {
    return <p className="px-1 py-3 text-[11px] text-muted">{empty}</p>;
  }
  return (
    <div className="mt-1 grid max-h-40 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-card-border bg-hover/30 p-2">
      {items.map((it) => {
        const on = selected.includes(it.id);
        return (
          <label
            key={it.id}
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] ${on ? "bg-foreground/10 text-foreground" : "text-muted hover:bg-hover"}`}
          >
            <input type="checkbox" checked={on} onChange={() => onToggle(it.id)} />
            <span className="truncate">{it.label}</span>
          </label>
        );
      })}
    </div>
  );
}
