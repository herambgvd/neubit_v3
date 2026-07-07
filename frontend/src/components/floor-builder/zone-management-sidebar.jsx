"use client";

// Zone list + properties editor sidebar for the floor-plan editor.
// Ported from neubit_v2 (shadcn) → neubit_v3's kit + semantic tokens.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import { Badge, Button, ConfirmDialog, Input, Modal, Select, Textarea, Toggle } from "@/components/ui/kit";
import {
  THREAT_LEVELS,
  ZONE_PRESET_COLORS,
  ZONE_TYPES,
} from "@/components/floor-builder/constants";

function buildZoneForm(zone) {
  return {
    name: zone?.name || "",
    description: zone?.description || "",
    zone_type: zone?.zone_type || "other",
    threat_level: zone?.threat_level || "normal",
    color: zone?.color || "#2563eb",
    max_occupancy: zone?.max_occupancy ?? "",
    alert_on_entry: !!zone?.alert_on_entry,
    alert_on_exit: !!zone?.alert_on_exit,
  };
}

function ZoneRow({ zone, isSelected, expanded, onToggle, onSelect, onEdit, onDelete }) {
  const threat = THREAT_LEVELS.find((t) => t.value === zone.threat_level);
  return (
    <div
      className={`rounded-md border transition ${
        isSelected ? "border-blue-500/60 bg-blue-500/10" : "border-card-border bg-card hover:bg-hover"
      }`}
    >
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="rounded p-0.5 text-muted hover:bg-hover"
        >
          <Icon
            icon={expanded ? "heroicons-outline:chevron-down" : "heroicons-outline:chevron-right"}
            className="text-sm"
          />
        </button>
        <span
          className="h-3 w-3 shrink-0 rounded-sm border border-card-border"
          style={{ backgroundColor: zone.color || "#2563eb" }}
        />
        <button
          type="button"
          onClick={onSelect}
          className="flex-1 truncate text-left text-sm font-medium text-foreground"
        >
          {zone.name || "Untitled zone"}
        </button>
        {threat ? (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${threat.dot}`} title={`Threat: ${threat.label}`} />
        ) : null}
        <button
          type="button"
          onClick={onEdit}
          title="Edit"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:pencil-square" className="text-sm" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-red-500 hover:bg-red-500/10 hover:text-red-600"
        >
          <Icon icon="heroicons-outline:trash" className="text-sm" />
        </button>
      </div>
      {expanded && (
        <div className="space-y-1 border-t border-card-border px-3 py-2 text-[11px] text-muted">
          <div className="flex items-center justify-between">
            <span>Type</span>
            <span className="text-foreground">{zone.zone_type || "other"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Points</span>
            <span className="text-foreground">{zone.polygon?.length ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Max occupancy</span>
            <span className="text-foreground">{zone.max_occupancy ?? "—"}</span>
          </div>
          {(zone.alert_on_entry || zone.alert_on_exit) && (
            <div className="flex flex-wrap gap-1 pt-1">
              {zone.alert_on_entry && <Badge color="slate">Alert on entry</Badge>}
              {zone.alert_on_exit && <Badge color="slate">Alert on exit</Badge>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ZonePropertiesModal({ open, onClose, zone, onSave }) {
  const [form, setForm] = useState(() => buildZoneForm(zone));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setForm(buildZoneForm(zone));
  }, [open, zone]);

  if (!zone) return null;

  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async () => {
    setSaving(true);
    try {
      await onSave?.({
        name: form.name?.trim() || "Untitled zone",
        description: form.description || null,
        zone_type: form.zone_type,
        threat_level: form.threat_level,
        color: form.color,
        max_occupancy: form.max_occupancy === "" ? null : Number(form.max_occupancy),
        alert_on_entry: form.alert_on_entry,
        alert_on_exit: form.alert_on_exit,
      });
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      title={zone.zone_id && !String(zone.zone_id).startsWith("draft_") ? "Edit zone" : "New zone"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Name" value={form.name} onChange={(e) => update({ name: e.target.value })} />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Type"
            value={form.zone_type}
            options={ZONE_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            onChange={(e) => update({ zone_type: e.target.value })}
          />
          <Select
            label="Threat level"
            value={form.threat_level}
            options={THREAT_LEVELS.map((t) => ({ value: t.value, label: t.label }))}
            onChange={(e) => update({ threat_level: e.target.value })}
          />
        </div>
        <div>
          <span className="block text-sm font-medium text-foreground mb-1.5">Color</span>
          <div className="flex items-center gap-1.5">
            {ZONE_PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => update({ color: c })}
                className={`h-6 w-6 rounded-md border-2 transition ${
                  form.color === c ? "border-foreground" : "border-transparent"
                }`}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
            <input
              type="color"
              value={form.color}
              onChange={(e) => update({ color: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-card-border bg-transparent"
            />
          </div>
        </div>
        <Input
          label="Max occupancy"
          type="number"
          min={0}
          value={form.max_occupancy}
          onChange={(e) => update({ max_occupancy: e.target.value })}
        />
        <div className="flex items-center justify-between rounded-md border border-card-border px-3 py-2">
          <span className="text-sm text-foreground">Alert on entry</span>
          <Toggle checked={form.alert_on_entry} onChange={(v) => update({ alert_on_entry: v })} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-card-border px-3 py-2">
          <span className="text-sm text-foreground">Alert on exit</span>
          <Toggle checked={form.alert_on_exit} onChange={(v) => update({ alert_on_exit: v })} />
        </div>
        <Textarea
          label="Description"
          rows={2}
          value={form.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </div>
    </Modal>
  );
}

export function ZoneManagementSidebar({
  zones = [],
  selectedZoneId,
  onSelectZone,
  onZoneUpdate,
  onZoneDelete,
  onStartDrawing,
}) {
  const [expanded, setExpanded] = useState(() => new Set());
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <aside className="flex w-72 shrink-0 flex-col rounded-lg border border-card-border bg-card">
      <div className="flex items-center justify-between border-b border-card-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
          <Icon icon="heroicons-outline:square-2-stack" className="text-base" />
          Zones
          <span className="ml-1 rounded-full bg-hover px-1.5 py-0.5 text-[11px] font-semibold text-foreground">
            {zones.length}
          </span>
        </div>
        <Button variant="success" icon="heroicons-outline:plus" onClick={onStartDrawing} className="!px-2.5 !py-1.5 text-xs">
          Draw
        </Button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto px-3 py-3">
        {zones.length === 0 ? (
          <div className="rounded-md border border-dashed border-card-border bg-hover/40 px-3 py-6 text-center text-xs text-muted">
            No zones yet — click <strong>Draw</strong> and click on the canvas to place polygon points.
          </div>
        ) : (
          zones.map((zone) => (
            <ZoneRow
              key={zone.zone_id}
              zone={zone}
              isSelected={zone.zone_id === selectedZoneId}
              expanded={expanded.has(zone.zone_id)}
              onToggle={() => toggle(zone.zone_id)}
              onSelect={() => onSelectZone?.(zone)}
              onEdit={() => setEditing(zone)}
              onDelete={() =>
                setConfirm({
                  title: "Delete zone?",
                  message: `Remove "${zone.name || "this zone"}" from the floor?`,
                  confirmLabel: "Delete",
                  onConfirm: () => {
                    onZoneDelete?.(zone);
                    setConfirm(null);
                  },
                })
              }
            />
          ))
        )}
      </div>

      <ZonePropertiesModal
        open={!!editing}
        onClose={() => setEditing(null)}
        zone={editing}
        onSave={(patch) => onZoneUpdate?.(editing, patch)}
      />
      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
    </aside>
  );
}
