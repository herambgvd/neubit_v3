"use client";

// Create/edit modal for a SOP state — name, description, color (swatch grid +
// custom picker), and the initial/terminal/cancellation flags. Persists via the
// states API; position is carried through from the node or the add-default.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { fieldClass, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { idOf } from "@/lib/format";
import { DEFAULT_COLOR } from "./lib/canvasGeometry";
import { workflow as wfApi } from "../api";

const sid = (s) => idOf(s, "state_id", "id");
const STATE_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#8B5CF6", "#EC4899", "#64748B"];

export default function StateModal({ sopId, state, defaults, onClose, onSaved }) {
  const isEdit = !!state;
  const [name, setName] = useState(state?.name || "");
  const [description, setDescription] = useState(state?.description || "");
  const [color, setColor] = useState(state?.color || DEFAULT_COLOR);
  const [isInitial, setIsInitial] = useState(!!state?.is_initial);
  const [isTerminal, setIsTerminal] = useState(!!state?.is_terminal);
  const [isCancellation, setIsCancellation] = useState(!!state?.is_cancellation);
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: (body) => (isEdit ? wfApi.states.update(sopId, sid(state), body) : wfApi.states.create(sopId, body)),
    onSuccess: () => { toast.success(isEdit ? "State updated" : "State created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit() {
    if (!name.trim()) { setErr("Name is required"); return; }
    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      color,
      is_initial: isInitial,
      is_terminal: isTerminal,
      is_cancellation: isCancellation,
      position_x: state?.position_x ?? defaults?.position_x ?? 40,
      position_y: state?.position_y ?? defaults?.position_y ?? 40,
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit state · ${state.name}` : "Add state"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={save.isPending}>{save.isPending ? "Saving…" : isEdit ? "Save changes" : "Add state"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <FieldLabel required>Name</FieldLabel>
          <input autoFocus value={name} onChange={(e) => { setName(e.target.value); if (err) setErr(""); }} className={`${fieldClass} ${err ? "!border-red-500" : ""}`} placeholder="e.g. Acknowledged" />
          {err && <p className="mt-1 text-xs text-red-500">{err}</p>}
        </div>
        <div>
          <FieldLabel>Description</FieldLabel>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={fieldClass} placeholder="Optional" />
        </div>
        <div>
          <FieldLabel>Color</FieldLabel>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {STATE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className="h-7 w-7 rounded-full border-2 transition"
                style={{ backgroundColor: c, borderColor: color === c ? "var(--foreground)" : "transparent" }}
                title={c}
              />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-7 w-9 rounded border border-card-border bg-transparent cursor-pointer" title="Custom color" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isInitial} onChange={(e) => setIsInitial(e.target.checked)} /> Initial</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isTerminal} onChange={(e) => setIsTerminal(e.target.checked)} /> Terminal</label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isCancellation} onChange={(e) => setIsCancellation(e.target.checked)} /> Cancellation</label>
        </div>
      </div>
    </Modal>
  );
}
