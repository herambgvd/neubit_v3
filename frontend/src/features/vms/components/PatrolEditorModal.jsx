"use client";

// PatrolEditorModal — create or edit a PTZ patrol (guard tour): an ordered list
// of preset stops, each with a dwell time, cycled at a shared speed. Reuses the
// camera's existing presets (loaded by the parent PtzOverlay and passed in).
//
// Gated on `vms.ptz.control` by the parent — this modal only opens for operators
// who can drive PTZ. On save it POSTs (create) or PATCHes (edit) via
// vms.ptz.patrols and lets the parent refetch the list.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";

import { Button, Modal, Input, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import vms from "../api";

export default function PatrolEditorModal({ cameraId, presets = [], patrol, onClose, onSaved }) {
  const editing = !!patrol;
  const [name, setName] = useState(patrol?.name || "");
  const [speed, setSpeed] = useState(patrol?.speed ?? 0.5);
  const [stops, setStops] = useState(() =>
    (patrol?.stops || []).map((s) => ({
      preset_id: s.preset_id,
      dwell_seconds: s.dwell_seconds ?? 5,
    }))
  );

  const presetOptions = useMemo(
    () => presets.map((p) => ({ value: String(p.id), label: p.name || `Preset ${p.id}` })),
    [presets]
  );

  const addStop = () => {
    const first = presets[0];
    setStops((s) => [...s, { preset_id: first ? first.id : "", dwell_seconds: 5 }]);
  };
  const removeStop = (i) => setStops((s) => s.filter((_, idx) => idx !== i));
  const patchStop = (i, patch) =>
    setStops((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  const moveStop = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    setStops((s) => {
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        speed: Number(speed),
        stops: stops
          .filter((s) => s.preset_id !== "" && s.preset_id != null)
          .map((s) => ({
            preset_id: s.preset_id,
            dwell_seconds: Math.max(1, Number(s.dwell_seconds) || 1),
          })),
      };
      return editing
        ? vms.ptz.patrols.update(cameraId, patrol.id, body)
        : vms.ptz.patrols.create(cameraId, body);
    },
    onSuccess: () => {
      toast.success(editing ? "Patrol updated" : "Patrol created");
      onSaved?.();
      onClose?.();
    },
    onError: (e) => toast.error(apiError(e, "Could not save patrol")),
  });

  const validStops = stops.filter((s) => s.preset_id !== "" && s.preset_id != null);
  const canSave = name.trim() && validStops.length >= 1 && !save.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={editing ? `Edit patrol — ${patrol.name}` : "New patrol"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create patrol"}
          </Button>
        </>
      }
    >
      {presets.length === 0 ? (
        <div className="rounded-lg border border-card-border bg-hover/40 px-4 py-6 text-center text-sm text-muted">
          Save at least one preset before building a patrol.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Input
                label="Patrol name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Perimeter sweep"
                autoFocus
              />
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">Speed</span>
              <Select
                value={String(speed)}
                onChange={(e) => setSpeed(e.target.value)}
                options={[
                  { value: "0.25", label: "Slow" },
                  { value: "0.5", label: "Medium" },
                  { value: "0.75", label: "Fast" },
                  { value: "1", label: "Max" },
                ]}
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">
                Stops <span className="text-muted">({validStops.length})</span>
              </span>
              <Button variant="secondary" icon="heroicons-outline:plus" onClick={addStop}>
                Add stop
              </Button>
            </div>

            {stops.length === 0 ? (
              <p className="rounded-lg border border-dashed border-card-border px-4 py-6 text-center text-xs text-muted">
                No stops yet. Add presets in the order the camera should tour them.
              </p>
            ) : (
              <ul className="space-y-2">
                {stops.map((s, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 py-2"
                  >
                    <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums text-muted">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Select
                        value={String(s.preset_id)}
                        onChange={(e) => patchStop(i, { preset_id: numericId(e.target.value, presets) })}
                        options={presetOptions}
                      />
                    </div>
                    <div className="flex w-28 shrink-0 items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        value={s.dwell_seconds}
                        onChange={(e) => patchStop(i, { dwell_seconds: e.target.value })}
                        className="w-16 rounded-md border border-field bg-transparent px-2 py-1.5 text-sm text-foreground outline-none focus:border-muted"
                      />
                      <span className="text-xs text-muted">sec</span>
                    </div>
                    <div className="flex shrink-0 items-center">
                      <IconBtn icon="heroicons-mini:chevron-up" title="Move up" onClick={() => moveStop(i, -1)} disabled={i === 0} />
                      <IconBtn icon="heroicons-mini:chevron-down" title="Move down" onClick={() => moveStop(i, 1)} disabled={i === stops.length - 1} />
                      <IconBtn icon="heroicons-outline:trash" title="Remove" onClick={() => removeStop(i)} danger />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// The Select emits string values; map back to the preset's real id type.
function numericId(value, presets) {
  const match = presets.find((p) => String(p.id) === String(value));
  return match ? match.id : value;
}

function IconBtn({ icon, title, onClick, disabled, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md p-1.5 transition disabled:opacity-30 ${
        danger ? "text-red-400 hover:bg-red-500/10" : "text-muted hover:bg-hover hover:text-foreground"
      }`}
    >
      <Icon icon={icon} className="text-sm" />
    </button>
  );
}
