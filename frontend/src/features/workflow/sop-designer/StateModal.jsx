"use client";

// Create/edit modal for a SOP state — name, description, color (swatch grid +
// custom picker), and the initial/terminal/cancellation flags. Persists via the
// states API; position is carried through from the node or the add-default.
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { fieldClass, areaClass, FieldLabel } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { titleize, asItems, idOf } from "@/lib/format";
import { DEFAULT_COLOR } from "./lib/canvasGeometry";
import { workflow as wfApi } from "../api";

const sid = (s) => idOf(s, "state_id", "id");
const roleId = (r) => r.role_id || r.id;
const roleName = (r) => r.display_name || titleize(r.name) || roleId(r);
const chipCls = (active) =>
  `text-xs rounded-full border px-2.5 py-1 transition ${
    active
      ? "border-blue-500 bg-blue-500/10 text-blue-500"
      : "border-card-border bg-card text-muted hover:bg-hover"
  }`;
const STATE_COLORS = ["#6366F1", "#10B981", "#F59E0B", "#EF4444", "#3B82F6", "#8B5CF6", "#EC4899", "#64748B"];

export default function StateModal({ sopId, state, defaults, onClose, onSaved }) {
  const isEdit = !!state;
  const [name, setName] = useState(state?.name || "");
  const [description, setDescription] = useState(state?.description || "");
  const [color, setColor] = useState(state?.color || DEFAULT_COLOR);
  const [isInitial, setIsInitial] = useState(!!state?.is_initial);
  const [isTerminal, setIsTerminal] = useState(!!state?.is_terminal);
  const [isCancellation, setIsCancellation] = useState(!!state?.is_cancellation);
  const [slaHours, setSlaHours] = useState(state?.sla_hours ?? "");
  const [requiredRoleIds, setRequiredRoleIds] = useState(state?.required_role_ids || []);
  const [err, setErr] = useState("");

  const rolesQ = useQuery({
    queryKey: ["auth-roles-min"],
    queryFn: () => api.get("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = asItems(rolesQ.data);

  const toggleRole = (id) =>
    setRequiredRoleIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

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
      sla_hours: slaHours === "" ? null : Number(slaHours),
      required_role_ids: requiredRoleIds,
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
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={areaClass} placeholder="Describe what this state represents" />
        </div>
        <div>
          <FieldLabel>SLA (hours)</FieldLabel>
          <input type="number" min={0} step="any" value={slaHours} onChange={(e) => setSlaHours(e.target.value)} className={fieldClass} placeholder="Optional" />
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
        <div>
          <FieldLabel>Required roles</FieldLabel>
          {rolesQ.isLoading ? (
            <div className="text-xs text-muted">Loading roles…</div>
          ) : roles.length === 0 ? (
            <div className="text-xs text-muted">No roles available.</div>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {roles.map((r) => (
                <button key={roleId(r)} type="button" onClick={() => toggleRole(roleId(r))} className={chipCls(requiredRoleIds.includes(roleId(r)))}>
                  {roleName(r)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
