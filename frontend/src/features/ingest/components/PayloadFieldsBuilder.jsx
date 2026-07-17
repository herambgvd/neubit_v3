"use client";

// Interactive payload builder (ported from neubit_v2 payload-fields-builder).
//
//   1. Paste a sample event from your vendor.
//   2. Click "Find fields" — we walk the JSON, list every leaf path, and
//      pre-tick the ones that look useful (name/mac/serial/timestamp/…).
//   3. Tick the fields you want, name each one, and mark which are required.
//   4. Pick which field identifies the device (optional).
//
// Produces all three of the webhook's payload settings at once:
//   transform          { outKey: "jmespath.path" } — the kept fields
//   payload_schema     a JSON Schema requiring the ticked-required source paths
//   device_lookup_expr the chosen device-identifying path
// The parent owns the state; this component is fully controlled.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";

import { Button } from "@/components/ui/kit";
import { areaClass } from "@/components/common";

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

// Preference order when auto-suggesting the device-identifying field: most
// stable identifier first (a MAC survives a rename, a device_name doesn't).
const DEVICE_MATCH_PREFERENCE = ["mac", "serial", "device_id", "hostname", "device_name"];

export default function PayloadFieldsBuilder({
  sampleText,
  onSampleTextChange,
  fields, // [{ path, name, checked, required }]
  onFieldsChange,
  // Device match (step 4) — omitted by the rule form, which has no such field.
  showDeviceMatch = false,
  deviceMatchPath = "",
  onDeviceMatchPathChange,
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
      return { path: p, name: dedupeName(tail, fields, p), checked: auto, required: false };
    });
    onFieldsChange(next);

    // Suggest a device-match path if the operator hasn't chosen one.
    if (showDeviceMatch && onDeviceMatchPathChange && !deviceMatchPath) {
      const suggestion = suggestDeviceMatch(next);
      if (suggestion) onDeviceMatchPathChange(suggestion);
    }
  };

  const setField = (i, patch) => {
    const next = fields.slice();
    next[i] = { ...next[i], ...patch };
    // Unticking a field can't leave it required — the schema would demand a path
    // the transform no longer reads.
    if (patch.checked === false) next[i].required = false;
    onFieldsChange(next);
  };

  // Group fields by their parent path so the list stays digestible for deeply
  // nested payloads.
  const groups = useMemo(() => groupByParent(fields), [fields]);
  const checkedCount = fields.filter((f) => f.checked).length;
  const requiredCount = fields.filter((f) => f.checked && f.required).length;
  const checkedFields = useMemo(() => fields.filter((f) => f.checked && f.path), [fields]);

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
              {checkedCount} kept · {requiredCount} required
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
            <div className="grid grid-cols-[20px_1fr_1fr_110px_60px] items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wide text-muted">
              <div></div>
              <div>Output key</div>
              <div>From payload</div>
              <div>Sample value</div>
              <div className="text-center">Required</div>
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
                            onRequired={(required) => setField(i, { required })}
                          />
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted">
            Required fields make the webhook reject events that don&apos;t include them
            (422) instead of publishing a half-empty payload.
          </p>
        </Step>
      ) : null}

      {/* Step 3 — device match */}
      {showDeviceMatch && checkedFields.length > 0 ? (
        <Step
          number={3}
          title="Which field identifies the device?"
          hint="Ships with every event so a consumer can attach device / site context."
        >
          <select
            value={deviceMatchPath || ""}
            onChange={(e) => onDeviceMatchPathChange?.(e.target.value)}
            className="h-8 w-full rounded-md border border-field bg-transparent px-2 text-xs text-foreground outline-none focus:border-muted"
          >
            <option value="">None (skip device lookup)</option>
            {checkedFields.map((f) => (
              <option key={f.path} value={f.path}>
                {f.name} — {f.path}
              </option>
            ))}
          </select>
          {deviceMatchPath ? (
            <p className="font-mono text-[11px] text-muted">
              Preview: {formatPreview(previewValue(sample, deviceMatchPath))}
            </p>
          ) : null}
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

function FieldRow({ field, preview, onCheck, onName, onRequired }) {
  return (
    <label
      className={`grid cursor-pointer grid-cols-[20px_1fr_1fr_110px_60px] items-center gap-2 px-2 py-1.5 hover:bg-hover ${
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
      <span className="flex justify-center">
        <input
          type="checkbox"
          checked={!!field.required}
          disabled={!field.checked}
          onChange={(e) => onRequired(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          title="Reject events missing this field"
          className="h-3.5 w-3.5 cursor-pointer accent-amber-500 disabled:opacity-40"
        />
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

function suggestDeviceMatch(fields) {
  for (const want of DEVICE_MATCH_PREFERENCE) {
    const hit = fields.find(
      (f) => f.checked && lastSegment(f.path).toLowerCase() === want,
    );
    if (hit) return hit.path;
  }
  return "";
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
    required: false,
  }));
}

/** "a.b[0].c" → ["a","b","c"] — array indices don't name a schema property. */
export function pathToObjectKeys(p) {
  return String(p)
    .split(".")
    .map((seg) => seg.replace(/\[\d+\]/g, ""))
    .filter(Boolean);
}

/**
 * Ticked-required source paths → a JSON Schema that demands each one.
 *
 * "data.dev_net_info[0].mac" becomes a nested object chain with `required` at
 * every level, so a payload missing any link is rejected — not just one missing
 * the leaf. Array indices collapse to the property (`dev_net_info`): the schema
 * asserts the array exists, and how many items it holds is the vendor's business.
 */
export function buildSchemaFromRequiredPaths(paths) {
  const required = (paths || []).filter(Boolean);
  if (!required.length) return {};

  const root = { type: "object", required: [], properties: {} };
  for (const p of required) {
    const keys = pathToObjectKeys(p);
    if (!keys.length) continue;
    let node = root;
    keys.forEach((key, i) => {
      if (!node.required.includes(key)) node.required.push(key);
      const isLeaf = i === keys.length - 1;
      if (isLeaf) {
        node.properties[key] = node.properties[key] || {};
        return;
      }
      const existing = node.properties[key];
      node.properties[key] =
        existing && existing.type === "object"
          ? existing
          : { type: "object", required: [], properties: {} };
      node = node.properties[key];
    });
  }
  return root;
}

/** Inverse: recover the required source paths from a saved JSON Schema. */
export function extractRequiredPaths(schema) {
  const out = [];
  const walk = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    for (const key of node.required || []) {
      const path = prefix ? `${prefix}.${key}` : key;
      const child = node.properties?.[key];
      if (child && child.type === "object" && (child.required || []).length) {
        walk(child, path);
      } else {
        out.push(path);
      }
    }
  };
  walk(schema, "");
  return out;
}

/** UI state → the three webhook payload settings the backend stores. */
export function fieldsToBackendShape(fields, deviceMatchPath) {
  const kept = (fields || []).filter((f) => f.checked && f.name && f.path);
  return {
    transform: fieldsToTransform(kept),
    payload_schema: buildSchemaFromRequiredPaths(
      kept.filter((f) => f.required).map((f) => f.path),
    ),
    device_lookup_expr: deviceMatchPath || null,
  };
}

/** Inverse: rebuild the UI state from a saved webhook. */
export function backendShapeToFields(webhook) {
  const fields = transformToFields(webhook?.transform);
  // A schema written by hand may require paths this transform never reads —
  // only re-tick the ones we can actually show a row for.
  const requiredPaths = new Set(extractRequiredPaths(webhook?.payload_schema));
  for (const f of fields) {
    if (requiredPaths.has(f.path)) f.required = true;
  }
  return { fields, deviceMatchPath: webhook?.device_lookup_expr || "" };
}

// Exported for reuse / tests.
export { DEVICE_MATCH_PREFERENCE };
