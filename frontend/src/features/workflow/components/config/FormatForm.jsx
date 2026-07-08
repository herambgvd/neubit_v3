"use client";

// Create/edit form for an alert format — maps an alert_code to presentation
// (category/severity/priority/color/icon/sound) and an optional target SOP.
// Mirrors TriggerForm's shape: shared Field for the primary controls, a compact
// bespoke row for the colour swatches (below Field's control API). The parent
// (FormatsTab) owns the mutation; this form just collects + validates a body.
import { useState } from "react";
import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { titleize, idOf } from "@/lib/format";

const SEVERITIES = ["low", "medium", "high", "critical"];
const PRIORITIES = ["low", "medium", "high", "critical"];
const SOP_MODES = ["manual", "automatic"];
// A few sensible swatches; a native colour input covers the rest.
const SWATCHES = ["#ef4444", "#f97316", "#f59e0b", "#22c55e", "#3b82f6", "#6366f1", "#a855f7", "#64748b"];

export default function FormatForm({ format, sops, pending, onCancel, onSubmit }) {
  const isEdit = !!format;
  const [name, setName] = useState(format?.name || "");
  const [alertCode, setAlertCode] = useState(format?.alert_code || "");
  const [description, setDescription] = useState(format?.description || "");
  const [category, setCategory] = useState(format?.category || "custom");
  const [severity, setSeverity] = useState(format?.severity || "medium");
  const [priority, setPriority] = useState(format?.priority || "medium");
  const [colorCode, setColorCode] = useState(format?.color_code || "#ef4444");
  const [icon, setIcon] = useState(format?.icon || "");
  const [alertSound, setAlertSound] = useState(!!format?.alert_sound);
  const [sopId, setSopId] = useState(format?.sop_id || "");
  const [sopMode, setSopMode] = useState(format?.sop_mode || "manual");
  const [isActive, setIsActive] = useState(format?.is_active !== false);
  const [errors, setErrors] = useState({});

  function clearErr(k) {
    if (errors[k]) setErrors((p) => ({ ...p, [k]: undefined }));
  }

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!alertCode.trim()) next.alertCode = "Alert code is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    onSubmit({
      name: name.trim(),
      alert_code: alertCode.trim(),
      description: description.trim() || null,
      category: category.trim() || "custom",
      severity,
      priority,
      color_code: colorCode,
      icon: icon.trim() || null,
      alert_sound: alertSound,
      sop_id: sopId || null,
      sop_mode: sopMode,
      is_active: isActive,
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${format.name}` : "Add alert format"}</h4>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); clearErr("name"); }}
          placeholder="e.g. Perimeter breach"
          error={errors.name}
        />
        <Field
          label="Alert code"
          required
          value={alertCode}
          onChange={(e) => { setAlertCode(e.target.value); clearErr("alertCode"); }}
          placeholder="e.g. ALERT_PERIMETER"
          className="font-mono"
          error={errors.alertCode}
        />
        <Field
          containerClassName="md:col-span-2"
          as="textarea"
          rows={2}
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — what this alert means"
        />
        <Field
          label="Category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g. custom, intrusion, fire"
          hint="Free text — defaults to “custom”."
        />
        <Field
          as="select"
          label="Severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          options={SEVERITIES.map((s) => ({ value: s, label: titleize(s) }))}
        />
        <Field
          as="select"
          label="Priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          options={PRIORITIES.map((p) => ({ value: p, label: titleize(p) }))}
        />
        <Field
          label="Icon"
          value={icon}
          onChange={(e) => setIcon(e.target.value)}
          placeholder="Optional — e.g. heroicons-outline:fire"
          className="font-mono"
        />
      </div>

      {/* Colour — swatches + custom picker (compact, below Field's control API) */}
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">Colour</label>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColorCode(c)}
              title={c}
              className={`h-7 w-7 rounded-md border transition ${colorCode.toLowerCase() === c ? "ring-2 ring-offset-1 ring-offset-card ring-foreground border-transparent" : "border-card-border"}`}
              style={{ background: c }}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-card-border" />
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(colorCode) ? colorCode : "#ef4444"}
            onChange={(e) => setColorCode(e.target.value)}
            className="h-7 w-9 cursor-pointer rounded border border-card-border bg-transparent p-0.5"
            title="Custom colour"
          />
          <input
            value={colorCode}
            onChange={(e) => setColorCode(e.target.value)}
            className="h-8 w-28 rounded-lg border border-field bg-transparent px-2.5 text-sm font-mono text-foreground outline-none focus:border-muted"
            placeholder="#ef4444"
          />
        </div>
      </div>

      {/* Workflow link */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          as="select"
          label="Linked SOP"
          value={sopId}
          onChange={(e) => setSopId(e.target.value)}
          options={[{ value: "", label: "No SOP linked" }, ...sops.map((s) => ({ value: idOf(s, "id", "sop_id"), label: s.name }))]}
          hint="Alerts of this kind can raise an incident from this SOP."
        />
        <Field
          as="select"
          label="SOP mode"
          value={sopMode}
          onChange={(e) => setSopMode(e.target.value)}
          options={SOP_MODES.map((m) => ({ value: m, label: titleize(m) }))}
          hint="Automatic raises the incident without an operator."
        />
      </div>

      <div className="flex flex-wrap items-center gap-5">
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={alertSound} onChange={(e) => setAlertSound(e.target.checked)} /> Play alert sound
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active
        </label>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={pending} className="!px-3 !py-1.5 text-xs">{pending ? "Saving…" : isEdit ? "Save changes" : "Create format"}</Button>
      </div>
    </form>
  );
}
