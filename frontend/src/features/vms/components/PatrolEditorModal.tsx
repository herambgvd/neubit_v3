"use client";

// PatrolEditorModal — edit the recorder's HOST-DRIVEN patrol for one federated
// camera: an ordered list of preset stops, each with a dwell, optionally shuffled.
//
// One patrol per camera, not a named list of them. That is the recorder's model
// (`GET|PUT …/ptz/patrol`, kind:"host_driven") and the console follows it. The
// earlier version of this modal created named patrol rows in the VMS's own table;
// nothing on the camera or the recorder ever knew about them, so the console could
// show a patrol the device would never run.
//
// "Host-driven" is the recorder stepping the head preset by preset, which is the
// fallback for firmware with no native ONVIF preset tour. The stops therefore
// reference DEVICE preset tokens — the same tokens the preset bar lists — because
// the recorder recalls them on the camera itself.
//
// Gated on `vms.ptz.control` by the parent, which only opens it for operators who
// can drive PTZ.
import { useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";

import { Button, Modal, Select } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import vms from "../api";
import type { FederatedPatrol, FederatedPatrolStop, FederatedPreset } from "../types";

// A stop while it is being edited — dwell binds to a number input, so it may be a
// string until save coerces it.
interface StopDraft {
  /** Identity for the row, not for the recorder — stripped before the save. A
   *  stop is `{preset_token, dwell_seconds}` and the recorder gives it no id, so
   *  without this the only key a row has is its position. Move-up/move-down
   *  reorders these, and a keyed-by-position row keeps the focus and the
   *  half-typed dwell of whatever now sits at that position. */
  uid: string;
  preset_token: string;
  dwell_seconds: number | string;
}

let stopSeq = 0;
const nextUid = () => `stop-${(stopSeq += 1)}`;

const DEFAULT_DWELL = 5;

export interface PatrolEditorModalProps {
  nodeId: string;
  cameraId: string;
  presets?: FederatedPreset[];
  patrol?: FederatedPatrol | null;
  onClose?: () => void;
  onSaved?: () => void;
}

export default function PatrolEditorModal({
  nodeId,
  cameraId,
  presets = [],
  patrol,
  onClose,
  onSaved,
}: PatrolEditorModalProps) {
  const [randomOrder, setRandomOrder] = useState(!!patrol?.random_order);
  const [defaultDwell, setDefaultDwell] = useState<number | string>(
    patrol?.default_dwell_seconds ?? DEFAULT_DWELL
  );
  const [stops, setStops] = useState<StopDraft[]>(() =>
    (patrol?.stops || []).map((s: FederatedPatrolStop) => ({
      uid: nextUid(),
      preset_token: s.preset_token,
      dwell_seconds: s.dwell_seconds ?? DEFAULT_DWELL,
    }))
  );

  const presetOptions = presets.map((p) => ({
    value: p.token,
    label: p.name || `Preset ${p.token}`,
  }));

  const addStop = () => {
    const first = presets[0];
    setStops((s) => [...s, { uid: nextUid(), preset_token: first ? first.token : "", dwell_seconds: DEFAULT_DWELL }]);
  };
  const removeStop = (i: number) => setStops((s) => s.filter((_, idx) => idx !== i));
  const patchStop = (i: number, patch: Partial<StopDraft>) =>
    setStops((s) => s.map((st, idx) => (idx === i ? { ...st, ...patch } : st)));
  const moveStop = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    setStops((s) => {
      const next = [...s];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = useMutation({
    // `stops` REPLACES the recorder's list wholesale — an empty array clears it —
    // so every field the modal owns is sent on every save. Sending a partial body
    // would leave the recorder's copy of an untouched field in place, which reads
    // as the edit silently not applying.
    mutationFn: () =>
      vms.federation.patrol.set(nodeId, cameraId, {
        random_order: randomOrder,
        default_dwell_seconds: Math.max(1, Number(defaultDwell) || DEFAULT_DWELL),
        stops: stops
          .filter((s) => !!s.preset_token)
          .map((s) => ({
            preset_token: s.preset_token,
            dwell_seconds: Math.max(1, Number(s.dwell_seconds) || DEFAULT_DWELL),
          })),
      }),
    onSuccess: () => {
      toast.success("Patrol saved");
      onSaved?.();
      onClose?.();
    },
    onError: (e) => toast.error(apiError(e, "Could not save patrol")),
  });

  const validStops = stops.filter((s) => !!s.preset_token);
  const canSave = validStops.length >= 1 && !save.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Patrol"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? "Saving…" : "Save patrol"}
          </Button>
        </>
      }
    >
      {presets.length === 0 ? (
        <div className="rounded-lg border border-card-border bg-hover/40 px-4 py-6 text-center text-sm text-muted">
          Save at least one preset on this camera before building a patrol.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">Default dwell</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={defaultDwell}
                  onChange={(e) => setDefaultDwell(e.target.value)}
                  className="w-20 rounded-md border border-field bg-transparent px-2 py-1.5 text-sm text-foreground outline-hidden focus:border-muted"
                />
                <span className="text-xs text-muted">seconds, for stops that set none</span>
              </div>
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">Order</span>
              <Select
                value={randomOrder ? "random" : "sequential"}
                onChange={(e) => setRandomOrder(e.target.value === "random")}
                options={[
                  { value: "sequential", label: "In order" },
                  { value: "random", label: "Shuffled" },
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
                    key={s.uid}
                    className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 py-2"
                  >
                    <span className="w-6 shrink-0 text-center text-xs font-semibold tabular-nums text-muted">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Select
                        value={s.preset_token}
                        onChange={(e) => patchStop(i, { preset_token: e.target.value })}
                        options={presetOptions}
                      />
                    </div>
                    <div className="flex w-28 shrink-0 items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        value={s.dwell_seconds}
                        onChange={(e) => patchStop(i, { dwell_seconds: e.target.value })}
                        className="w-16 rounded-md border border-field bg-transparent px-2 py-1.5 text-sm text-foreground outline-hidden focus:border-muted"
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

interface IconBtnProps {
  icon: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function IconBtn({ icon, title, onClick, disabled, danger }: IconBtnProps) {
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
