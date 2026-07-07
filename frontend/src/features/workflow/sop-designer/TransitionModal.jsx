"use client";

// Create/edit modal for a SOP transition — label, from/to state selects,
// description, and the requires-note / confirmation-required flags. Persists via
// the transitions API.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { fieldClass, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { idOf } from "@/lib/format";
import { workflow as wfApi } from "../api";

const sid = (s) => idOf(s, "state_id", "id");
const tid = (t) => idOf(t, "transition_id", "id");

export default function TransitionModal({ sopId, states, transition, defaults, onClose, onSaved }) {
  const isEdit = !!transition;
  const [label, setLabel] = useState(transition?.label || "");
  const [description, setDescription] = useState(transition?.description || "");
  const [fromId, setFromId] = useState(transition?.from_state_id ?? defaults?.from_state_id ?? "");
  const [toId, setToId] = useState(transition?.to_state_id ?? defaults?.to_state_id ?? "");
  const [requiresNote, setRequiresNote] = useState(!!transition?.requires_note);
  const [confirmationRequired, setConfirmationRequired] = useState(!!transition?.confirmation_required);
  const [errors, setErrors] = useState({});

  const save = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.transitions.update(sopId, tid(transition), body) : wfApi.transitions.create(sopId, body)),
    onSuccess: () => { toast.success(isEdit ? "Transition updated" : "Transition created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    const next = {};
    if (!label.trim()) next.label = "Label is required";
    if (!fromId) next.fromId = "From state required";
    if (!toId) next.toId = "To state required";
    if (Object.keys(next).length) { setErrors(next); return; }
    save.mutate({
      label: label.trim(),
      description: description.trim() || null,
      from_state_id: fromId,
      to_state_id: toId,
      requires_note: requiresNote,
      confirmation_required: confirmationRequired,
    });
  }

  const opts = states.map((s) => ({ id: sid(s), name: s.name }));

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit transition · ${transition.label}` : "Add transition"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add transition"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <FieldLabel required>Label</FieldLabel>
          <input autoFocus value={label} onChange={(e) => { setLabel(e.target.value); if (errors.label) setErrors((p) => ({ ...p, label: undefined })); }} className={`${fieldClass} ${errors.label ? "!border-red-500" : ""}`} placeholder="e.g. Acknowledge" />
          {errors.label && <p className="mt-1 text-xs text-red-500">{errors.label}</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel required>From</FieldLabel>
            <select value={fromId} onChange={(e) => { setFromId(e.target.value); if (errors.fromId) setErrors((p) => ({ ...p, fromId: undefined })); }} className={`${fieldClass} ${errors.fromId ? "!border-red-500" : ""}`}>
              <option value="" className="bg-card">Select…</option>
              {opts.map((o) => <option key={o.id} value={o.id} className="bg-card">{o.name}</option>)}
            </select>
            {errors.fromId && <p className="mt-1 text-xs text-red-500">{errors.fromId}</p>}
          </div>
          <div>
            <FieldLabel required>To</FieldLabel>
            <select value={toId} onChange={(e) => { setToId(e.target.value); if (errors.toId) setErrors((p) => ({ ...p, toId: undefined })); }} className={`${fieldClass} ${errors.toId ? "!border-red-500" : ""}`}>
              <option value="" className="bg-card">Select…</option>
              {opts.map((o) => <option key={o.id} value={o.id} className="bg-card">{o.name}</option>)}
            </select>
            {errors.toId && <p className="mt-1 text-xs text-red-500">{errors.toId}</p>}
          </div>
        </div>
        <div>
          <FieldLabel>Description</FieldLabel>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={fieldClass} placeholder="Optional" />
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={requiresNote} onChange={(e) => setRequiresNote(e.target.checked)} /> Requires note</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={confirmationRequired} onChange={(e) => setConfirmationRequired(e.target.checked)} /> Confirmation required</label>
        </div>
      </div>
    </Modal>
  );
}
