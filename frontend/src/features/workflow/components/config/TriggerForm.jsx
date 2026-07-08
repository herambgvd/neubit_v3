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
import { MATCHER_OPS, OP_LABEL } from "../../lib/matcher";
import ConditionsPreview from "./ConditionsPreview";

const TRIGGER_OPS = MATCHER_OPS;

const DEDUP_STRATEGIES = [
  { value: "per_event_type", label: "Per event type", hint: "One incident per (source, type) within the window. Default." },
  { value: "per_event_id", label: "Per event ID", hint: "Suppress repeats sharing the envelope's event_id." },
  { value: "per_field", label: "Per field value", hint: "Group by a payload field (e.g. payload.device_id)." },
];

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
      ? trigger.conditions.map((c) => ({ path: c.path || c.field || "", op: c.op || c.operator || "eq", value: c.value ?? "" }))
      : [],
  );
  const [dedupStrategy, setDedupStrategy] = useState(trigger?.dedup?.strategy || "per_event_type");
  const [dedupKeyField, setDedupKeyField] = useState(trigger?.dedup?.key_field || "");
  const [dedupWindow, setDedupWindow] = useState(
    trigger?.dedup?.window_seconds ?? 3600,
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
    const dedup = {
      strategy: dedupStrategy,
      window_seconds: Number(dedupWindow) || 0,
    };
    if (dedupStrategy === "per_field") dedup.key_field = dedupKeyField.trim() || null;
    onSubmit({
      name: name.trim(),
      event_source: eventSource.trim() || null,
      event_type: eventType.trim(),
      sop_id: sopId,
      priority: priority || null,
      enabled,
      conditions: cleanConds,
      dedup,
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
                  {TRIGGER_OPS.map((o) => <option key={o} value={o} className="bg-card">{OP_LABEL[o] || o}</option>)}
                </select>
                <input value={c.value} onChange={(e) => updateCond(i, { value: e.target.value })} placeholder="value" className="h-9 w-28 rounded-lg border border-field bg-transparent px-2.5 text-sm text-foreground outline-none focus:border-muted" />
                <button type="button" onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded text-muted hover:bg-hover hover:text-red-500"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-2">
          <ConditionsPreview conditions={conditions} />
        </div>
      </div>

      {/* Deduplication */}
      <div>
        <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-muted">Deduplication</label>
        <p className="mb-2 text-[11px] text-muted/70">Within the window, events resolving to the same dedup key are suppressed — only the first raises an incident.</p>
        <div className="space-y-2">
          {DEDUP_STRATEGIES.map((s) => {
            const active = dedupStrategy === s.value;
            return (
              <label key={s.value} className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${active ? "border-blue-500/50 bg-blue-500/10" : "border-card-border bg-card hover:bg-hover"}`}>
                <input type="radio" name="dedup-strategy" checked={active} onChange={() => setDedupStrategy(s.value)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{s.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted">{s.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
          {dedupStrategy === "per_field" && (
            <Field
              label="Key field"
              value={dedupKeyField}
              onChange={(e) => setDedupKeyField(e.target.value)}
              placeholder="payload.device_id"
            />
          )}
          <Field
            label="Window (seconds)"
            type="number"
            min={0}
            value={dedupWindow}
            onChange={(e) => setDedupWindow(e.target.value === "" ? "" : Number(e.target.value))}
          />
        </div>
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
