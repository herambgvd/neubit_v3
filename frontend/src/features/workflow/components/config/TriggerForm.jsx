"use client";

// Create/edit form for a trigger: name, event source/type, target SOP, priority
// override, an AND-list of JSON-path conditions, and an enabled toggle. The
// condition rows use compact inline inputs (below Field's control height) so they
// stay bespoke; the primary fields use the shared Field.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { titleize, idOf } from "@/lib/format";
import { PRIORITIES } from "../../constants";

const TRIGGER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "regex"];

export default function TriggerForm({ trigger, sops, pending, onCancel, onSubmit }) {
  const isEdit = !!trigger;
  const [name, setName] = useState(trigger?.name || "");
  const [eventSource, setEventSource] = useState(trigger?.event_source || "");
  const [eventType, setEventType] = useState(trigger?.event_type || "");
  const [sopId, setSopId] = useState(trigger?.sop_id || "");
  const [priority, setPriority] = useState(trigger?.priority || "");
  const [enabled, setEnabled] = useState(trigger?.enabled !== false);
  const [conditions, setConditions] = useState(
    Array.isArray(trigger?.conditions) && trigger.conditions.length
      ? trigger.conditions.map((c) => ({ path: c.path || "", op: c.op || "eq", value: c.value ?? "" }))
      : [],
  );
  const [errors, setErrors] = useState({});

  function updateCond(i, patch) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!eventType.trim()) next.eventType = "Event type is required";
    if (!sopId) next.sopId = "Target SOP is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    const cleanConds = conditions
      .filter((c) => c.path.trim())
      .map((c) => ({ path: c.path.trim(), op: c.op, value: c.value === "" ? null : c.value }));
    onSubmit({
      name: name.trim(),
      event_source: eventSource.trim() || null,
      event_type: eventType.trim(),
      sop_id: sopId,
      priority: priority || null,
      enabled,
      conditions: cleanConds,
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${trigger.name}` : "Add trigger"}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          containerClassName="md:col-span-2"
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }}
          placeholder="e.g. Fire alarm → Fire SOP"
          error={errors.name}
        />
        <Field
          label="Event source"
          value={eventSource}
          onChange={(e) => setEventSource(e.target.value)}
          placeholder="e.g. ingest, camera"
        />
        <Field
          label="Event type"
          required
          value={eventType}
          onChange={(e) => { setEventType(e.target.value); if (errors.eventType) setErrors((p) => ({ ...p, eventType: undefined })); }}
          placeholder="e.g. fire.alarm or *"
          error={errors.eventType}
        />
        <Field
          as="select"
          label="Target SOP"
          required
          value={sopId}
          onChange={(e) => { setSopId(e.target.value); if (errors.sopId) setErrors((p) => ({ ...p, sopId: undefined })); }}
          error={errors.sopId}
          options={[{ value: "", label: "Select a SOP…" }, ...sops.map((s) => ({ value: idOf(s, "id", "sop_id"), label: s.name }))]}
        />
        <Field
          as="select"
          label="Priority override"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          options={[{ value: "", label: "Use SOP default" }, ...PRIORITIES.map((p) => ({ value: p, label: titleize(p) }))]}
        />
      </div>

      {/* Conditions (AND) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">Conditions (all must match)</label>
          <button type="button" onClick={() => setConditions((cs) => [...cs, { path: "", op: "eq", value: "" }])} className="text-xs text-blue-500 hover:underline">+ Add condition</button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-[11px] text-muted/70">No conditions — the trigger fires on any matching event type.</p>
        ) : (
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input value={c.path} onChange={(e) => updateCond(i, { path: e.target.value })} placeholder="payload.path" className="h-9 flex-1 rounded-lg border border-field bg-transparent px-2.5 text-sm font-mono text-foreground outline-none focus:border-muted" />
                <select value={c.op} onChange={(e) => updateCond(i, { op: e.target.value })} className="h-9 rounded-lg border border-field bg-transparent px-2 text-sm text-foreground outline-none focus:border-muted">
                  {TRIGGER_OPS.map((o) => <option key={o} value={o} className="bg-card">{o}</option>)}
                </select>
                <input value={c.value} onChange={(e) => updateCond(i, { value: e.target.value })} placeholder="value" className="h-9 w-28 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
                <button type="button" onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
      </label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={pending} className="!px-3 !py-1.5 text-xs">{pending ? "Saving…" : isEdit ? "Save changes" : "Create trigger"}</Button>
      </div>
    </form>
  );
}
