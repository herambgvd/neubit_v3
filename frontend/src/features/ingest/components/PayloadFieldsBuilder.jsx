"use client";

// Interactive transform builder (ported 1:1 from neubit_v2 payload-fields-builder).
//
//   1. Paste a sample event from your vendor.
//   2. Click "Find fields" — we walk the JSON, list every leaf path, and
//      pre-tick the ones that look useful (name/mac/serial/timestamp/…).
//   3. Tick the fields you want and name each one.
//
// The output is the webhook `transform` dict — a flat map of
//   { outKey: "jmespath.path" }
// where the target key is the (editable) field name and the value is the
// dotted/bracketed source path into the incoming payload. The parent owns the
// state; this component is fully controlled.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import { FieldLabel, areaClass } from "@/components/common";

// Heuristics: pre-tick these field-name patterns when found in the sample.
const AUTO_PICK_NAMES = new Set([
  "device_name", "name", "hostname",
  "mac", "serial", "device_id",
  "ip", "ip_address",
  "channel", "channel_name",
  "alarm_type", "event_type", "type",
  "timestamp", "time", "alarm_time",
  "severity", "level",
  "message",
]);

// Heuristics: mark these as "required" candidates (device-identifying keys).
const IMPORTANT_NAMES = ["mac", "serial", "device_id", "hostname", "device_name"];

export default function PayloadFieldsBuilder({
  sampleText,
  onSampleTextChange,
  fields, // [{ path, name, checked }]
  onFieldsChange,
}) {
  const [parseError, setParseError] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});

  const sample = useMemo(() => {
    if (!sampleText || !sampleText.trim()) {
      setParseError(null);
      return null;
    }
    try {
      const parsed = JSON.parse(sampleText);
      setParseError(null);
      return parsed;
    } catch (e) {
      setParseError(e.message);
      return null;
    }
  }, [sampleText]);

  // Derive the candidate field list whenever the user analyzes the sample.
  // Preserve existing edits (checked / name) for paths seen before so users
  // don't lose their work when iterating on the sample.
  const handleAnalyze = () => {
    if (!sample) return;
    const leaves = collectLeafPaths(sample, "", []);
    const existing = new Map(fields.map((f) => [f.path, f]));
    const next = leaves.map((p) => {
      const prev = existing.get(p);
      if (prev) return prev;
      const tail = lastSegment(p);
      const auto = AUTO_PICK_NAMES.has(tail.toLowerCase());
      return { path: p, name: dedupeName(tail, fields, p), checked: auto };
    });
    onFieldsChange(next);
  };

  const setField = (i, patch) => {
    const next = fields.slice();
    next[i] = { ...next[i], ...patch };
    onFieldsChange(next);
  };

  // Group fields by their parent path so the list stays digestible for deeply
  // nested payloads.
  const groups = useMemo(() => groupByParent(fields), [fields]);
  const checkedCount = fields.filter((f) => f.checked).length;

  return (
    <div className="space-y-4 rounded-lg border border-card-border bg-hover/30 p-3">
      {/* Step 1 — sample */}
      <Step number={1} title="Paste an example event from your vendor">
        <textarea
          value={sampleText}
          onChange={(e) => onSampleTextChange(e.target.value)}
          rows={6}
          className={`${areaClass} font-mono text-xs`}
          placeholder={`{\n  "device": { "name": "Cam-04", "mac": "AA:BB:CC:DD:EE:FF" },\n  "alarm": { "type": "motion", "channel": 1 }\n}`}
          spellCheck={false}
        />
        {parseError ? (
          <div className="flex items-center gap-1 text-xs text-red-500">
            <Icon icon="heroicons-outline:exclamation-circle" className="text-sm" />
            JSON error: {parseError}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            icon="heroicons-outline:arrow-path"
            disabled={!sample}
            onClick={handleAnalyze}
            className="!px-3 !py-1.5 text-xs"
          >
            {fields.length === 0 ? "Find fields" : "Re-analyze"}
          </Button>
          {fields.length > 0 ? (
            <span className="text-[11px] text-muted">
              {fields.length} field{fields.length === 1 ? "" : "s"} found ·{" "}
              {checkedCount} kept
            </span>
          ) : null}
        </div>
      </Step>

      {/* Step 2 — fields list */}
      {fields.length > 0 ? (
        <Step
          number={2}
          title="Tick the fields you want and name each output key"
          hint="Each kept field becomes one entry in the transform map: outKey → source path."
        >
          <div className="space-y-1.5">
            {/* Header row */}
            <div className="grid grid-cols-[20px_1fr_1fr_110px] items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wide text-muted">
              <div></div>
              <div>Output key</div>
              <div>From payload</div>
              <div>Sample value</div>
            </div>

            {Object.entries(groups).map(([groupKey, groupFields]) => {
              const collapsed = collapsedGroups[groupKey];
              return (
                <div key={groupKey} className="rounded-md border border-card-border bg-card">
                  {/* Group header */}
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedGroups((s) => ({ ...s, [groupKey]: !s[groupKey] }))
                    }
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                  >
                    <Icon
                      icon={
                        collapsed
                          ? "heroicons-outline:chevron-right"
                          : "heroicons-outline:chevron-down"
                      }
                      className="text-xs text-muted"
                    />
                    <span className="font-mono text-[11px] text-muted">
                      {groupKey || "(root)"}
                    </span>
                    <span className="text-[10px] text-muted/70">
                      {groupFields.filter((f) => f.checked).length} / {groupFields.length} kept
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="border-t border-card-border">
                      {groupFields.map((field) => {
                        const i = fields.indexOf(field);
                        const preview = formatPreview(previewValue(sample, field.path));
                        return (
                          <FieldRow
                            key={field.path}
                            field={field}
                            preview={preview}
                            onCheck={(checked) => setField(i, { checked })}
                            onName={(name) => setField(i, { name })}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Step>
      ) : null}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────

function Step({ number, title, hint, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-[10px] font-bold text-background">
          {number}
        </span>
        <div>
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
        </div>
      </div>
      <div className="ml-7 space-y-2">{children}</div>
    </div>
  );
}

function FieldRow({ field, preview, onCheck, onName }) {
  return (
    <label
      className={`grid cursor-pointer grid-cols-[20px_1fr_1fr_110px] items-center gap-2 px-2 py-1.5 hover:bg-hover ${
        !field.checked ? "opacity-60" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={field.checked}
        onChange={(e) => onCheck(e.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer accent-foreground"
      />
      <input
        value={field.name}
        onChange={(e) => onName(e.target.value)}
        disabled={!field.checked}
        onClick={(e) => e.stopPropagation()}
        className="h-7 w-full rounded-md border border-field bg-transparent px-2 text-xs text-foreground outline-none focus:border-muted disabled:opacity-50"
      />
      <span className="truncate font-mono text-[11px] text-muted" title={field.path}>
        {field.path}
      </span>
      <span className="truncate font-mono text-[11px] text-foreground" title={String(preview)}>
        {preview}
      </span>
    </label>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function lastSegment(p) {
  const parts = p.split(".");
  const last = parts[parts.length - 1] || p;
  return last.replace(/\[\d+\]$/, ""); // strip array indices
}

function dedupeName(name, fields, path) {
  const used = new Set(fields.filter((f) => f.path !== path).map((f) => f.name));
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(`${name}_${i}`)) i++;
  return `${name}_${i}`;
}

function groupByParent(fields) {
  const groups = {};
  for (const f of fields) {
    const parent = parentPath(f.path);
    if (!groups[parent]) groups[parent] = [];
    groups[parent].push(f);
  }
  return groups;
}

function parentPath(p) {
  const idx = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
  return idx <= 0 ? "" : p.slice(0, idx).replace(/\.$/, "");
}

function collectLeafPaths(obj, prefix, acc) {
  if (obj === null || obj === undefined) {
    if (prefix) acc.push(prefix);
    return acc;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      if (prefix) acc.push(prefix);
      return acc;
    }
    // Walk first item only — arrays are usually homogeneous.
    collectLeafPaths(obj[0], `${prefix}[0]`, acc);
    return acc;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectLeafPaths(v, next, acc);
    }
    return acc;
  }
  if (prefix) acc.push(prefix);
  return acc;
}

export function previewValue(sample, dottedPath) {
  if (!sample || !dottedPath) return undefined;
  try {
    const parts = parsePath(dottedPath);
    let cur = sample;
    for (const part of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[part];
    }
    return cur;
  } catch {
    return undefined;
  }
}

function parsePath(p) {
  const out = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

function formatPreview(v) {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 20 ? `"${v.slice(0, 20)}…"` : `"${v}"`;
  if (typeof v === "object") return Array.isArray(v) ? `[…${v.length}]` : "{…}";
  return String(v);
}

// ── Shape converters (used by the parent form) ────────────────────

/** UI field list → transform dict { outKey: "jmespath.path" }. */
export function fieldsToTransform(fields) {
  const out = {};
  for (const f of (fields || []).filter((f) => f.checked && f.name && f.path)) {
    out[f.name] = f.path;
  }
  return out;
}

/** Inverse: rebuild UI fields from a saved transform dict. */
export function transformToFields(transform) {
  const map = transform || {};
  return Object.entries(map).map(([name, path]) => ({
    path: typeof path === "string" ? path : "",
    name,
    checked: true,
  }));
}

// Exported for potential reuse / tests.
export { IMPORTANT_NAMES };
