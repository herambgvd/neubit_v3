"use client";

// Edit form for an existing security zone (name, type, threat level, color,
// occupancy, alert flags, description, active). Fills the Zones tab in-place.
//
// EDIT ONLY — zones are created by drawing a polygon in the floor-plan editor
// (Floors tab). A zone created here would have no geometry: invisible on the plan,
// not selectable, and not a valid device drop target, with no way to add a shape
// afterwards. So this form deliberately has no create mode and no floor picker.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { FieldLabel, fieldClass } from "@/components/common";
import { apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { ZONE_TYPES, THREAT_LEVELS, capitalize } from "../constants";
import { FInput, FTextarea, FSelect, FCheckbox } from "./FormControls";

export default function ZoneForm({ zone, onCancel, onSaved }) {
  const [name, setName] = useState(zone?.name || "");
  const [description, setDescription] = useState(zone?.description || "");
  const [zoneType, setZoneType] = useState(zone?.zone_type || "other");
  const [threatLevel, setThreatLevel] = useState(zone?.threat_level || "normal");
  const [color, setColor] = useState(zone?.color || "#6366F1");
  const [maxOccupancy, setMaxOccupancy] = useState(zone?.max_occupancy ?? "");
  const [alertOnEntry, setAlertOnEntry] = useState(!!zone?.alert_on_entry);
  const [alertOnExit, setAlertOnExit] = useState(!!zone?.alert_on_exit);
  const [isActive, setIsActive] = useState(zone?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => sitesApi.zones.update(zone.zone_id, body),
    onSuccess: () => {
      setErrors({});
      toast.success("Zone updated");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) {
      setErrors({ name: "Name is required" });
      return;
    }
    saving.mutate({
      name: name.trim(),
      description: description.trim() || null,
      zone_type: zoneType,
      threat_level: threatLevel,
      color: color || null,
      alert_on_entry: alertOnEntry,
      alert_on_exit: alertOnExit,
      max_occupancy: maxOccupancy === "" ? null : Number(maxOccupancy),
      is_active: isActive,
    });
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">Edit zone · {zone.name}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <FieldLabel required>Name</FieldLabel>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
            }}
            placeholder="Enter zone name"
            className={`${fieldClass} ${errors.name ? "!border-red-500" : ""}`}
          />
          {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name}</p>}
        </div>
        <FSelect label="Zone type" value={zoneType} onChange={setZoneType}>
          {ZONE_TYPES.map((t) => (
            <option key={t} value={t} className="bg-card">{t.replace(/_/g, " ")}</option>
          ))}
        </FSelect>
        <FSelect label="Threat level" value={threatLevel} onChange={setThreatLevel}>
          {THREAT_LEVELS.map((t) => (
            <option key={t} value={t} className="bg-card">{capitalize(t)}</option>
          ))}
        </FSelect>
        <div>
          <FieldLabel>Color</FieldLabel>
          <div className="mt-1 flex items-center gap-2">
            <input type="color" value={color || "#6366F1"} onChange={(e) => setColor(e.target.value)} className="h-10 w-16 rounded-md border border-field cursor-pointer bg-transparent" />
            <input value={color || ""} onChange={(e) => setColor(e.target.value)} className="h-10 flex-1 rounded-md border border-field bg-transparent px-3 text-sm font-mono text-foreground outline-none focus:border-muted" />
          </div>
        </div>
        <FInput label="Max occupancy" type="number" min={0} value={maxOccupancy} onChange={setMaxOccupancy} placeholder="Max occupancy" />
        <FCheckbox label="Alert on entry" value={alertOnEntry} onChange={setAlertOnEntry} />
        <FCheckbox label="Alert on exit" value={alertOnExit} onChange={setAlertOnExit} />
        <FTextarea label="Description" full value={description} onChange={setDescription} rows={2} placeholder="Zone description (optional)" />
        <FCheckbox label="Active" value={isActive} onChange={setIsActive} />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
