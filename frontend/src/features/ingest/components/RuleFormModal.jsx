"use client";

// Create / edit an event rule for a webhook.
//
// A rule says: "when an incoming payload looks like THIS, extract THESE fields
// and publish it as an event of THIS type." Pure database config — no code per
// vendor. Ported 1:1 from neubit_v2's rule-form-modal (identity + condition
// builder + field map + live tester), re-themed onto v3 shared components and
// wired to v3's event_type / target_domain rule shape.
//
// Sections:
//   1. Details — name, event_type (emitted), target_domain, priority, enabled, description
//   2. Match conditions — repeating {path, op, value} rows (ALL must hold)
//   3. Fields to extract — repeating {outKey, jmespath} rows → field_map
//   4. Test — paste sample JSON → per-condition ✓/✗ + overall matched + extracted
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Checkbox, Modal } from "@/components/ui/kit";
import { Field, FieldLabel, fieldClass } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import SelectMenu from "@/components/common/SelectMenu";

// Matcher operators — exact backend set.
const OP_OPTIONS = [
  { value: "exists", label: "is present" },
  { value: "not_exists", label: "is missing" },
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
];
const OP_NEEDS_VALUE = new Set(["equals", "not_equals", "contains"]);

// Try numeric / boolean / null literals; otherwise pass the raw string.
function parseValue(v) {
  if (v === "" || v === null || v === undefined) return v;
  const t = String(v).trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return v;
}

function formatValue(v) {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`;
  if (typeof v === "object") {
    try {
      const s = JSON.stringify(v);
      return s.length > 28 ? s.slice(0, 28) + "…" : s;
    } catch { return "[obj]"; }
  }
  return String(v);
}

export default function RuleFormModal({ webhookId, rule, onClose, onSaved }) {
  const isEdit = !!rule;

  // ── identity ──────────────────────────────────────────────────
  const [name, setName] = useState(rule?.name || "");
  const [description, setDescription] = useState(rule?.description || "");
  const [eventType, setEventType] = useState(rule?.event_type || "");
  const [targetDomain, setTargetDomain] = useState(rule?.target_domain || "");
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  // ── match conditions: [{path, op, value}] ─────────────────────
  const [conditions, setConditions] = useState(
    (rule?.match_conditions || []).map((c) => ({
      path: c.path || "",
      op: c.op || "exists",
      value: c.value ?? "",
    })),
  );

  // ── field map: repeating {outKey, jmespath} rows ──────────────
  const [fieldRows, setFieldRows] = useState(
    Object.entries(rule?.field_map || {}).map(([outKey, jmespath]) => ({ outKey, jmespath })),
  );

  // ── live test ─────────────────────────────────────────────────
  const [sampleText, setSampleText] = useState("");
  const [jsonErr, setJsonErr] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [errors, setErrors] = useState({});

  // Build the { path, op, value? } list the backend expects.
  const buildConditions = () =>
    conditions
      .filter((c) => c.path)
      .map((c) => ({
        path: c.path,
        op: c.op,
        ...(OP_NEEDS_VALUE.has(c.op) ? { value: parseValue(c.value) } : {}),
      }));

  // Build the { outKey: jmespath } field map.
  const buildFieldMap = () => {
    const map = {};
    for (const r of fieldRows) {
      if (r.outKey?.trim() && r.jmespath?.trim()) map[r.outKey.trim()] = r.jmespath.trim();
    }
    return map;
  };

  const save = useMutation({
    mutationFn: (body) =>
      isEdit ? ingestApi.eventRules.update(rule.id, body) : ingestApi.eventRules.create(webhookId, body),
    onSuccess: () => {
      toast.success(isEdit ? "Rule updated" : "Rule created");
      onSaved?.();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Dry-run against the sample. The test endpoint honors the proposed
  // match_conditions / field_map from the current draft, so you can preview
  // edits before saving — but it anchors on an existing rule id, so a
  // brand-new (never-saved) rule must be created first before it can be tested.
  const test = useMutation({
    mutationFn: (payload) =>
      ingestApi.eventRules.test(rule.id, {
        payload,
        match_conditions: buildConditions(),
        field_map: buildFieldMap(),
      }),
    onSuccess: (data) => setTestResult(data),
    onError: (e) => { setTestResult(null); toast.error(apiError(e)); },
  });

  function runTest() {
    if (!isEdit) { toast.error("Create the rule first, then reopen it to test."); return; }
    let payload;
    try { payload = sampleText.trim() ? JSON.parse(sampleText) : {}; }
    catch (err) { setJsonErr(`Invalid sample JSON: ${err.message}`); return; }
    setJsonErr("");
    test.mutate(payload);
  }

  function submit(e) {
    e?.preventDefault?.();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!eventType.trim()) next.eventType = "Event type is required";
    for (let i = 0; i < conditions.length; i++) {
      const c = conditions[i];
      if (!c.path) { toast.error(`Condition #${i + 1} needs a path`); return; }
      if (OP_NEEDS_VALUE.has(c.op) && c.value === "") { toast.error(`Condition #${i + 1} needs a value`); return; }
    }
    const seen = new Set();
    for (const r of fieldRows) {
      if (!r.outKey?.trim() && !r.jmespath?.trim()) continue;
      if (!r.outKey?.trim()) { toast.error("A field-map row is missing its output key"); return; }
      if (!r.jmespath?.trim()) { toast.error(`Field "${r.outKey}" needs a JMESPath expression`); return; }
      if (seen.has(r.outKey.trim())) { toast.error(`Output key "${r.outKey}" is used more than once`); return; }
      seen.add(r.outKey.trim());
    }
    if (Object.keys(next).length) { setErrors(next); return; }

    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      event_type: eventType.trim(),
      target_domain: targetDomain.trim() || null,
      priority: Number(priority) || 100,
      enabled,
      match_conditions: buildConditions(),
      field_map: buildFieldMap(),
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={isEdit ? `Edit rule · ${rule?.name}` : "New event rule"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create rule"}
          </Button>
        </>
      }
    >
      <form noValidate onSubmit={submit} className="space-y-5">
        {/* ── Details ──────────────────────────────────────────── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Name"
            required
            value={name}
            onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }}
            placeholder="Enter rule name"
            maxLength={128}
            error={errors.name}
          />
          <Field
            label="Event type (emitted)"
            required
            value={eventType}
            onChange={(e) => { setEventType(e.target.value); if (errors.eventType) setErrors((p) => ({ ...p, eventType: undefined })); }}
            placeholder="e.g. motion_alarm"
            className="font-mono"
            error={errors.eventType}
            hint="The event_type tagged onto matched events."
          />
          <Field
            label="Target domain"
            value={targetDomain}
            onChange={(e) => setTargetDomain(e.target.value)}
            placeholder="Optional (e.g. access)"
            className="font-mono"
          />
          <Field
            label="Priority"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            min={0}
            max={10000}
            hint="Lower = evaluated first."
          />
        </div>
        <Field
          as="textarea"
          label="Description"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Enter rule description (optional)"
          maxLength={1024}
        />
        <Checkbox label="Enabled" checked={enabled} onChange={setEnabled} />

        {/* ── Match conditions ─────────────────────────────────── */}
        <section className="space-y-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.4)] p-4">
          <div>
            <h4 className="text-sm font-semibold text-nb-ink">When should this rule fire?</h4>
            <p className="text-[11px] text-nb-faint">ALL conditions must hold. Most rules just need one: "this field is present."</p>
          </div>
          {conditions.length === 0 ? (
            <p className="text-[11px] text-nb-faint">No conditions — this rule matches any payload. Add one to make it specific.</p>
          ) : (
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  condition={c}
                  onChange={(patch) => {
                    const nextC = conditions.slice();
                    nextC[i] = { ...nextC[i], ...patch };
                    setConditions(nextC);
                  }}
                  onRemove={() => setConditions(conditions.filter((_, idx) => idx !== i))}
                />
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="secondary"
            icon="heroicons-outline:plus"
            className="!px-3 !py-1.5 text-xs"
            onClick={() => setConditions([...conditions, { path: "", op: "exists", value: "" }])}
          >
            Add condition
          </Button>
        </section>

        {/* ── Field map ────────────────────────────────────────── */}
        <section className="space-y-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.4)] p-4">
          <div>
            <h4 className="text-sm font-semibold text-nb-ink">Fields to extract</h4>
            <p className="text-[11px] text-nb-faint">When this rule fires, each output key is filled from a JMESPath expression over the payload.</p>
          </div>
          {fieldRows.length === 0 ? (
            <p className="text-[11px] text-nb-faint">No fields mapped — matched events publish with an empty payload.</p>
          ) : (
            <div className="space-y-2">
              {fieldRows.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
                  <input
                    value={r.outKey}
                    onChange={(e) => {
                      const nextF = fieldRows.slice();
                      nextF[i] = { ...nextF[i], outKey: e.target.value };
                      setFieldRows(nextF);
                    }}
                    placeholder="output key"
                    spellCheck={false}
                    className={`${fieldClass} !mt-0 !h-9 font-mono text-xs`}
                  />
                  <input
                    value={r.jmespath}
                    onChange={(e) => {
                      const nextF = fieldRows.slice();
                      nextF[i] = { ...nextF[i], jmespath: e.target.value };
                      setFieldRows(nextF);
                    }}
                    placeholder="jmespath.expression"
                    spellCheck={false}
                    className={`${fieldClass} !mt-0 !h-9 font-mono text-xs`}
                  />
                  <button
                    type="button"
                    onClick={() => setFieldRows(fieldRows.filter((_, idx) => idx !== i))}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-nb-faint transition hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
                    aria-label="Remove field"
                  >
                    <Icon icon="heroicons-outline:trash" className="text-sm" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="secondary"
            icon="heroicons-outline:plus"
            className="!px-3 !py-1.5 text-xs"
            onClick={() => setFieldRows([...fieldRows, { outKey: "", jmespath: "" }])}
          >
            Add field
          </Button>
        </section>

        {/* ── Test ─────────────────────────────────────────────── */}
        <section className="space-y-3 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.4)] p-4">
          <div>
            <h4 className="text-sm font-semibold text-nb-ink">Test this rule</h4>
            <p className="text-[11px] text-nb-faint">
              {isEdit
                ? "Paste a sample payload — checks the current draft conditions + field map (no save needed)."
                : "Save the rule first, then reopen it here to dry-run a sample payload."}
            </p>
          </div>
          <Field
            as="textarea"
            rows={5}
            value={sampleText}
            onChange={(e) => { setSampleText(e.target.value); if (jsonErr) setJsonErr(""); }}
            placeholder={'{\n  "data": { "motion_alarm": true }\n}'}
            className="font-mono"
            error={jsonErr}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              icon="heroicons-outline:play"
              className="!px-3 !py-1.5 text-xs"
              onClick={runTest}
              disabled={test.isPending || !isEdit}
            >
              {test.isPending ? "Testing…" : "Run test"}
            </Button>
            {testResult && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  testResult.matched
                    ? "border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good"
                    : "border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] text-nb-crit"
                }`}
              >
                <Icon icon={testResult.matched ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"} className="text-sm" />
                {testResult.matched ? "Rule matches" : "Does NOT match"}
              </span>
            )}
            {testResult?.event_type && (
              <span className="ml-auto truncate font-mono text-[11px] text-nb-faint">→ {testResult.event_type}</span>
            )}
          </div>

          {testResult?.condition_results?.length ? (
            <div className="divide-y divide-nb-line/50 rounded-[8px] border border-nb-line">
              {testResult.condition_results.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                  <div className="flex min-w-0 items-center gap-2">
                    <Icon
                      icon={r.ok ? "heroicons-outline:check-circle" : "heroicons-outline:x-circle"}
                      className={`shrink-0 text-sm ${r.ok ? "text-nb-good" : "text-nb-crit"}`}
                    />
                    <span className="truncate font-mono text-nb-soft">{r.path}</span>
                    <span className="shrink-0 text-nb-faint">{r.op}</span>
                    {r.expected !== undefined && r.expected !== null && (
                      <span className="font-mono text-nb-faint">{formatValue(r.expected)}</span>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-nb-faint">→ {formatValue(r.actual)}</span>
                </div>
              ))}
            </div>
          ) : null}

          {testResult?.extracted && (
            <div>
              <FieldLabel>Extracted output</FieldLabel>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[8px] border border-nb-line bg-[rgba(0,0,0,.35)] px-3 py-2 font-mono text-xs text-nb-soft">
                {JSON.stringify(testResult.extracted, null, 2)}
              </pre>
            </div>
          )}
        </section>
      </form>
    </Modal>
  );
}

function ConditionRow({ condition, onChange, onRemove }) {
  const needsValue = OP_NEEDS_VALUE.has(condition.op);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_150px_1fr_auto] items-center gap-2">
      <input
        value={condition.path}
        onChange={(e) => onChange({ path: e.target.value })}
        placeholder="data.alarm[0].motion"
        spellCheck={false}
        className={`${fieldClass} !mt-0 !h-9 font-mono text-xs`}
      />
      <SelectMenu
        value={condition.op}
        onChange={(e) => onChange({ op: e.target.value })}
        options={OP_OPTIONS}
        className="!mt-0 !h-9 !text-xs"
      />
      {needsValue ? (
        <input
          value={condition.value ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="value"
          className={`${fieldClass} !mt-0 !h-9 font-mono text-xs`}
        />
      ) : (
        <div className="px-1 text-[11px] text-nb-faint">(no value)</div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-nb-faint transition hover:bg-[rgba(248,113,113,.12)] hover:text-nb-crit"
        aria-label="Remove condition"
      >
        <Icon icon="heroicons-outline:trash" className="text-sm" />
      </button>
    </div>
  );
}
