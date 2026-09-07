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
import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { Icon } from "@iconify/react";

import { Button, checkboxClass } from "@/components/ui/kit";
import { areaClass } from "@/components/common";
import type { BuilderField } from "../types";

// Heuristics: pre-tick these field-name patterns when found in the sample.
const AUTO_PICK_NAMES = new Set<string>([
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

export interface PayloadFieldsBuilderProps {
  /** The pasted sample event, as raw text (the parent owns it). */
  sampleText: string;
  onSampleTextChange: (text: string) => void;
  /** The candidate rows: [{ path, name, checked }]. */
  fields: BuilderField[];
  onFieldsChange: (fields: BuilderField[]) => void;
}

export default function PayloadFieldsBuilder({
  sampleText,
  onSampleTextChange,
  fields, // [{ path, name, checked }]
  onFieldsChange,
}: PayloadFieldsBuilderProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Parse result AND its error come out of the same memo. They used to be state
  // written from inside it, which is a setState during render — React can (and
  // the compiler says will) loop on that.
  const { sample, parseError } = useMemo<{ sample: unknown; parseError: string | null }>(() => {
    if (!sampleText || !sampleText.trim()) return { sample: null, parseError: null };
    try {
      return { sample: JSON.parse(sampleText), parseError: null };
    } catch (e) {
      return { sample: null, parseError: (e as Error).message };
    }
  }, [sampleText]);

  // Derive the candidate field list whenever the user analyzes the sample.
  // Preserve existing edits (checked / name) for paths seen before so users
  // don't lose their work when iterating on the sample.
  const handleAnalyze = () => {
    if (!sample) return;
    const leaves = collectLeafPaths(sample, "", []);
    const existing = new Map<string, BuilderField>(fields.map((f) => [f.path, f]));
    const next = leaves.map((p) => {
      const prev = existing.get(p);
      if (prev) return prev;
      const tail = lastSegment(p);
      const auto = AUTO_PICK_NAMES.has(tail.toLowerCase());
      return { path: p, name: dedupeName(tail, fields, p), checked: auto };
    });
    onFieldsChange(next);
  };

  const setField = (i: number, patch: Partial<BuilderField>) => {
    const next = fields.slice();
    next[i] = { ...next[i], ...patch };
    onFieldsChange(next);
  };

  // Group fields by their parent path so the list stays digestible for deeply
  // nested payloads.
  const groups = useMemo(() => groupByParent(fields), [fields]);
  const checkedCount = fields.filter((f) => f.checked).length;

  return (
    <div className="space-y-4 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] p-3">
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
          <div className="flex items-center gap-1 text-xs text-nb-crit">
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
           
          >
            {fields.length === 0 ? "Find fields" : "Re-analyze"}
          </Button>
          {fields.length > 0 ? (
            <span className="text-[11px] text-nb-faint">
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
            <div className="grid grid-cols-[20px_1fr_1fr_110px] items-center gap-2 px-2 text-[10px] font-medium uppercase tracking-wide text-nb-faint">
              <div></div>
              <div>Output key</div>
              <div>From payload</div>
              <div>Sample value</div>
            </div>

            {Object.entries(groups).map(([groupKey, groupFields]) => {
              const collapsed = collapsedGroups[groupKey];
              return (
                <div key={groupKey} className="rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.5)]">
                  {/* Group header */}
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }))
                    }
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                  >
                    <Icon
                      icon={
                        collapsed
                          ? "heroicons-outline:chevron-right"
                          : "heroicons-outline:chevron-down"
                      }
                      className="text-xs text-nb-faint"
                    />
                    <span className="font-mono text-[11px] text-nb-soft">
                      {groupKey || "(root)"}
                    </span>
                    <span className="text-[10px] text-nb-faint">
                      {groupFields.filter((f) => f.checked).length} / {groupFields.length} kept
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="border-t border-nb-line">
                      {groupFields.map((field) => {
                        const i = fields.indexOf(field);
                        const preview = formatPreview(previewValue(sample, field.path));
                        return (
                          <FieldRow
                            key={field.path}
                            field={field}
                            preview={preview}
                            onCheck={(checked: boolean) => setField(i, { checked })}
                            onName={(name: string) => setField(i, { name })}
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

interface StepProps {
  number: number;
  title: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}

function Step({ number, title, hint, children }: StepProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-[rgba(96,165,250,.15)] text-[10px] font-bold text-nb-blueb">
          {number}
        </span>
        <div>
          <h4 className="text-sm font-semibold text-nb-ink">{title}</h4>
          {hint ? <p className="text-[11px] text-nb-faint">{hint}</p> : null}
        </div>
      </div>
      <div className="ml-7 space-y-2">{children}</div>
    </div>
  );
}

interface FieldRowProps {
  field: BuilderField;
  /** Already formatted for display (see `formatPreview`). */
  preview: string;
  onCheck: (checked: boolean) => void;
  onName: (name: string) => void;
}

function FieldRow({ field, preview, onCheck, onName }: FieldRowProps) {
  return (
    <label
      className={`grid cursor-pointer grid-cols-[20px_1fr_1fr_110px] items-center gap-2 px-2 py-1.5 transition hover:bg-[rgba(96,165,250,.05)] ${
        !field.checked ? "opacity-60" : ""
      }`}
    >
      <input
        type="checkbox"
        checked={field.checked}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onCheck(e.target.checked)}
        className={checkboxClass}
      />
      <input
        value={field.name}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onName(e.target.value)}
        disabled={!field.checked}
        onClick={(e: MouseEvent<HTMLInputElement>) => e.stopPropagation()}
        className="h-7 w-full rounded-[7px] border border-nb-line bg-[rgba(0,0,0,.35)] px-2 text-xs text-nb-blueb outline-hidden focus:border-nb-teal disabled:opacity-50"
      />
      <span className="truncate font-mono text-[11px] text-nb-faint" title={field.path}>
        {field.path}
      </span>
      <span className="truncate font-mono text-[11px] text-nb-soft" title={String(preview)}>
        {preview}
      </span>
    </label>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function lastSegment(p: string): string {
  const parts = p.split(".");
  const last = parts[parts.length - 1] || p;
  return last.replace(/\[\d+\]$/, ""); // strip array indices
}

function dedupeName(name: string, fields: BuilderField[], path: string): string {
  const used = new Set<string>(fields.filter((f) => f.path !== path).map((f) => f.name));
  if (!used.has(name)) return name;
  let i = 2;
  while (used.has(`${name}_${i}`)) i++;
  return `${name}_${i}`;
}

function groupByParent(fields: BuilderField[]): Record<string, BuilderField[]> {
  const groups: Record<string, BuilderField[]> = {};
  for (const f of fields) {
    const parent = parentPath(f.path);
    if (!groups[parent]) groups[parent] = [];
    groups[parent].push(f);
  }
  return groups;
}

function parentPath(p: string): string {
  const idx = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
  return idx <= 0 ? "" : p.slice(0, idx).replace(/\.$/, "");
}

// Walks the parsed sample — an arbitrary JSON value — and lists every leaf path.
function collectLeafPaths(obj: unknown, prefix: string, acc: string[]): string[] {
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
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const next = prefix ? `${prefix}.${k}` : k;
      collectLeafPaths(v, next, acc);
    }
    return acc;
  }
  if (prefix) acc.push(prefix);
  return acc;
}

export function previewValue(sample: unknown, dottedPath: string | null | undefined): unknown {
  if (!sample || !dottedPath) return undefined;
  try {
    const parts = parsePath(dottedPath);
    let cur: unknown = sample;
    for (const part of parts) {
      if (cur === null || cur === undefined) return undefined;
      cur = (cur as Record<string | number, unknown>)[part];
    }
    return cur;
  } catch {
    return undefined;
  }
}

function parsePath(p: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
  }
  return out;
}

function formatPreview(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 20 ? `"${v.slice(0, 20)}…"` : `"${v}"`;
  if (typeof v === "object") return Array.isArray(v) ? `[…${v.length}]` : "{…}";
  return String(v);
}

// ── Shape converters (used by the parent form) ────────────────────

/** UI field list → transform dict { outKey: "jmespath.path" }. */
export function fieldsToTransform(fields: BuilderField[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of (fields || []).filter((f) => f.checked && f.name && f.path)) {
    out[f.name] = f.path;
  }
  return out;
}

/** Inverse: rebuild UI fields from a saved transform dict. */
export function transformToFields(
  transform: Record<string, unknown> | null | undefined,
): BuilderField[] {
  const map = transform || {};
  return Object.entries(map).map(([name, path]) => ({
    path: typeof path === "string" ? path : "",
    name,
    checked: true,
  }));
}

// Exported for potential reuse / tests.
export { IMPORTANT_NAMES };
