"use client";

// Create/edit form for a trigger: name, description, event source/type, target
// SOP, priority override, auto-assign users, an AND-list of JSON-path
// conditions, deduplication, and an enabled toggle. Ported to full v2 field
// parity — description + assign_users (searchable UserMultiSelect) + dedup
// default 300s + event_type-OR-event_source validation + an inline Test button
// that opens TriggerTestModal against the current draft.
//
// The condition rows use compact inline inputs (below Field's control height) so
// they stay bespoke; the primary fields use the shared Field.
import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "@iconify/react";
import { Button, Checkbox } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { titleize } from "@/lib/format";
import { PRIORITIES, isPriority } from "../../constants";
import { randomId } from "@/lib/random";
import { MATCHER_OPS, OP_LABEL, stringifyValue } from "../../lib/matcher";
import type {
  CreateTriggerRequest,
  DedupConfig,
  DedupStrategy,
  SopPublic,
  TransitionCondition,
  TriggerPublic,
} from "../../types";
import UserMultiSelect from "../UserMultiSelect";
import ConditionsPreview from "./ConditionsPreview";
import type { ConditionRow } from "./ConditionsPreview";
import TriggerTestModal from "./TriggerTestModal";
import SelectMenu from "@/components/common/SelectMenu";
import { PaneForm } from "@/components/console";

const TRIGGER_OPS = MATCHER_OPS;

const DEDUP_STRATEGIES: { value: DedupStrategy; label: string; hint: string }[] = [
  { value: "per_event_type", label: "Per event type", hint: "One incident per (source, type) within the window. Default." },
  { value: "per_event_id", label: "Per event ID", hint: "Suppress repeats sharing the envelope's event_id." },
  { value: "per_field", label: "Per field value", hint: "Group by a payload field (e.g. payload.device_id)." },
];

type ErrorKey = "name" | "event" | "sopId";

// Editor rows carry the value as typed; the wire shape is TransitionCondition.
const toWire = (c: ConditionRow): TransitionCondition => ({
  field: c.path.trim(),
  operator: c.op,
  value: c.value === "" ? null : c.value,
});

export interface TriggerFormProps {
  /** The trigger being edited; null creates one. */
  trigger: TriggerPublic | null;
  sops: SopPublic[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: CreateTriggerRequest) => void;
}

// Pure, and therefore module scope. Declared in the component body these were a new
// function every render: a memo listing one honestly would rebuild every time, and the
// memo that omitted it was leaning on the omission being harmless. Stable here, so the
// dependency can simply be declared.

export default function TriggerForm({ trigger, sops, pending, onCancel, onSubmit }: TriggerFormProps) {
  const isEdit = !!trigger;
  const [name, setName] = useState(trigger?.name || "");
  const [description, setDescription] = useState(trigger?.description || "");
  const [eventSource, setEventSource] = useState(trigger?.event_source || "");
  const [eventType, setEventType] = useState(trigger?.event_type || "");
  const [sopId, setSopId] = useState(trigger?.sop_id || "");
  const [priority, setPriority] = useState<string>(trigger?.priority || "");
  const [assignUsers, setAssignUsers] = useState<string[]>(
    Array.isArray(trigger?.assign_users) ? trigger.assign_users : [],
  );
  const [enabled, setEnabled] = useState(trigger?.enabled !== false);
  const [conditions, setConditions] = useState<ConditionRow[]>(
    Array.isArray(trigger?.conditions) && trigger.conditions.length
      // stringifyValue is coerceValue's inverse — the editor must be seeded with
      // text the submit path can turn back into the value that was stored.
      ? trigger.conditions.map((c) => ({
          path: c.field || "",
          op: c.operator || "eq",
          value: c.value == null ? "" : stringifyValue(c.operator || "eq", c.value),
          _key: randomId(),
        }))
      : [],
  );
  const [dedupStrategy, setDedupStrategy] = useState<DedupStrategy>(trigger?.dedup?.strategy || "per_event_type");
  const [dedupKeyField, setDedupKeyField] = useState(trigger?.dedup?.key_field || "");
  const [dedupWindow, setDedupWindow] = useState<number | "">(
    trigger?.dedup?.window_seconds ?? 300,
  );
  const [errors, setErrors] = useState<Partial<Record<ErrorKey, string>>>({});
  const [showTest, setShowTest] = useState(false);

  function updateCond(i: number, patch: Partial<ConditionRow>) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  const toggleAssignUser = (uid: string) =>
    setAssignUsers((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : [...cur, uid]));

  // Draft trigger passed to the Test modal so it evaluates the live event_type +
  // conditions. When editing, carry the real id so the modal can locate the row
  // in the simulate result.
  const draftForTest = useMemo(
    (): Partial<TriggerPublic> => ({
      ...(trigger || {}),
      event_type: eventType.trim(),
      event_source: eventSource.trim(),
      conditions: conditions.filter((c) => c.path.trim()).map(toWire),
    }),
    [trigger, eventType, eventSource, conditions],
  );

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: Partial<Record<ErrorKey, string>> = {};
    if (!name.trim()) next.name = "Name is required";
    if (!eventType.trim() && !eventSource.trim()) next.event = "Specify event type, event source, or both";
    if (!sopId) next.sopId = "Target SOP is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    const cleanConds = conditions.filter((c) => c.path.trim()).map(toWire);
    const dedup: DedupConfig = {
      strategy: dedupStrategy,
      window_seconds: Number(dedupWindow) || 0,
    };
    if (dedupStrategy === "per_field") dedup.key_field = dedupKeyField.trim() || null;
    const body: CreateTriggerRequest = {
      name: name.trim(),
      description: description.trim() || null,
      // `str = ""` on the backend — "" (not null) means "any source".
      event_source: eventSource.trim(),
      event_type: eventType.trim() || null,
      sop_id: sopId,
      assign_users: assignUsers,
      enabled,
      conditions: cleanConds,
      dedup,
    };
    // Priority is a non-null enum on create; only send it when explicitly chosen
    // (blank == "use SOP default" → omit so the backend applies its default).
    if (isPriority(priority)) body.priority = priority;
    onSubmit(body);
  }

  return (
    <PaneForm
      title={trigger ? `Edit ${trigger.name}` : "Add trigger"}
      onSubmit={submit}
      action={
        <Button variant="secondary" icon="heroicons-outline:beaker" onClick={() => setShowTest(true)}>
          Test
        </Button>
      }
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={pending}>
            {pending ? "Saving…" : isEdit ? "Save changes" : "Create trigger"}
          </Button>
        </>
      }
    >
      {errors.event && <p className="mb-3 text-xs text-nb-crit">{errors.event}</p>}
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
          as="textarea"
          containerClassName="md:col-span-2"
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Enter trigger description (optional)"
        />
        <Field
          label="Event source"
          value={eventSource}
          onChange={(e) => { setEventSource(e.target.value); if (errors.event) setErrors((p) => ({ ...p, event: undefined })); }}
          placeholder="e.g. ingest, camera"
        />
        <Field
          label="Event type"
          value={eventType}
          onChange={(e) => { setEventType(e.target.value); if (errors.event) setErrors((p) => ({ ...p, event: undefined })); }}
          placeholder="e.g. fire.alarm or *"
        />
        <Field
          as="select"
          label="Target SOP"
          required
          value={sopId}
          onChange={(e) => { setSopId(e.target.value); if (errors.sopId) setErrors((p) => ({ ...p, sopId: undefined })); }}
          error={errors.sopId}
          options={[{ value: "", label: "Select a SOP…" }, ...sops.map((s) => ({ value: s.sop_id, label: s.name }))]}
        />
        <Field
          as="select"
          label="Priority override"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          options={[{ value: "", label: "Use SOP default" }, ...PRIORITIES.map((p) => ({ value: p, label: titleize(p) }))]}
        />
        <div className="md:col-span-2">
          <UserMultiSelect
            label="Auto-assign users"
            selectedIds={assignUsers}
            onToggle={toggleAssignUser}
            onClear={() => setAssignUsers([])}
          />
        </div>
      </div>

      {/* Conditions (AND) */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-nb-faint">Conditions (all must match)</span>
          <button type="button" onClick={() => setConditions((cs) => [...cs, { path: "", op: "eq", value: "", _key: randomId() }])} className="text-xs text-nb-blueb hover:underline">+ Add condition</button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-[11px] text-nb-faint/70">No conditions — the trigger fires on any matching event type.</p>
        ) : (
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={c._key} className="flex items-center gap-2">
                <input value={c.path} onChange={(e) => updateCond(i, { path: e.target.value })} placeholder="payload.path" className="h-9 flex-1 rounded-lg border border-nb-line bg-transparent px-2.5 text-sm font-mono text-nb-ink outline-hidden focus:border-nb-teal" />
                <span className="w-36 shrink-0">
                  <SelectMenu
                    value={c.op}
                    onChange={(e) => updateCond(i, { op: e.target.value })}
                    options={TRIGGER_OPS.map((o) => ({ value: o, label: OP_LABEL[o] || o }))}
                    className="!mt-0 !h-9"
                  />
                </span>
                <input value={c.value} onChange={(e) => updateCond(i, { value: e.target.value })} placeholder="value" className="h-9 w-28 rounded-lg border border-nb-line bg-transparent px-2.5 text-sm text-nb-ink outline-hidden focus:border-nb-teal" />
                <button type="button" onClick={() => setConditions((cs) => cs.filter((_, idx) => idx !== i))} className="h-9 w-9 inline-flex items-center justify-center rounded-sm text-nb-faint hover:bg-[rgba(96,165,250,.1)] hover:text-nb-crit"><Icon icon="heroicons-outline:x-mark" className="text-sm" /></button>
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
        <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-nb-faint">Deduplication</span>
        <p className="mb-2 text-[11px] text-nb-faint/70">Within the window, events resolving to the same dedup key are suppressed — only the first raises an incident.</p>
        <div className="space-y-2">
          {DEDUP_STRATEGIES.map((s) => {
            const active = dedupStrategy === s.value;
            return (
              <label key={s.value} className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${active ? "border-[rgba(96,165,250,.50)] bg-[rgba(96,165,250,.10)]" : "border-nb-line bg-[rgba(8,15,34,.5)] hover:bg-[rgba(96,165,250,.1)]"}`}>
                <input type="radio" name="dedup-strategy" checked={active} onChange={() => setDedupStrategy(s.value)} className="mt-0.5" />
                <span className="block text-sm font-medium text-nb-ink">{s.label}</span>
                <span className="col-start-2 mt-0.5 block text-[11px] text-nb-faint">{s.hint}</span>
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

      <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} />

      <TriggerTestModal open={showTest} trigger={draftForTest} onClose={() => setShowTest(false)} />
    </PaneForm>
  );
}
