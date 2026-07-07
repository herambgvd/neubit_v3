"use client";

// Create/edit form for a security zone (floor, name, type, threat level, color,
// occupancy, alert flags, description, active). Fills the Zones tab in-place.
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

export default function ZoneForm({ site, floors, zone, defaultFloorId, onCancel, onSaved }) {
  const isEdit = !!zone;
  const [floorId, setFloorId] = useState(zone?.floor_id || defaultFloorId || "");
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
    mutationFn: (body) => (isEdit ? sitesApi.zones.update(zone.zone_id, body) : sitesApi.zones.create(body)),
    onSuccess: () => {
      setErrors({});
      toast.success(isEdit ? "Zone updated" : "Zone created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!isEdit && !floorId) next.floorId = "Floor is required";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      zone_type: zoneType,
      threat_level: threatLevel,
      color: color || null,
      alert_on_entry: alertOnEntry,
      alert_on_exit: alertOnExit,
      max_occupancy: maxOccupancy === "" ? null : Number(maxOccupancy),
    };
    if (isEdit) body.is_active = isActive;
    else {
      body.site_id = site.site_id;
      body.floor_id = floorId;
    }
    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit zone · ${zone.name}` : "Add zone"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {!isEdit && (
          <div>
            <FieldLabel required>Floor</FieldLabel>
            <select
              value={floorId || ""}
              onChange={(e) => {
                setFloorId(e.target.value);
                if (errors.floorId) setErrors((p) => ({ ...p, floorId: undefined }));
              }}
              className={`${fieldClass} ${errors.floorId ? "!border-red-500" : ""}`}
            >
              <option value="" disabled className="bg-card">Select a floor</option>
              {floors.map((f) => (
                <option key={f.floor_id} value={f.floor_id} className="bg-card">{f.name}</option>
              ))}
            </select>
            {errors.floorId && <p className="mt-1 text-xs text-red-500">{errors.floorId}</p>}
          </div>
        )}
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
        {isEdit && <FCheckbox label="Active" value={isActive} onChange={setIsActive} />}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending || (!isEdit && !floorId)} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create zone"}
        </Button>
      </div>
    </form>
  );
}
