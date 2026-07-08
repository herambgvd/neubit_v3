"use client";

// Create / edit a cardholder. Ported from neubit_v2's cardholder-modal.jsx:
// first/last name (last required), employee id, email, PIN, description, valid
// from/until, an access-group multi-select, and (edit only) a cards manager.
// Rethemed to v3 tokens; uses kit Modal/Button + common Field.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";

export default function CardholderModal({ instanceId, cardholder, onClose, onSuccess }) {
  const isEdit = !!cardholder;
  const qc = useQueryClient();

  const [form, setForm] = useState(() => ({
    first_name: cardholder?.first_name || "",
    last_name: cardholder?.last_name || "",
    employee_id: cardholder?.employee_id || "",
    email: cardholder?.email || "",
    description: cardholder?.description || "",
    pin_code: cardholder?.pin_code || "",
    valid_from: cardholder?.valid_from?.slice(0, 16) || "",
    valid_until: cardholder?.valid_until?.slice(0, 16) || "",
  }));
  const [groupIds, setGroupIds] = useState(() => cardholder?.access_groups || []);
  const [errors, setErrors] = useState({});
  const [newCardId, setNewCardId] = useState("");

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const groupsQ = useQuery({
    queryKey: ["ac-access-groups", instanceId],
    queryFn: () => gates.accessGroups.list(instanceId),
    enabled: !!instanceId,
  });
  const groups = asItems(groupsQ.data);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["ac-cardholders", instanceId] });
    if (cardholder) qc.invalidateQueries({ queryKey: ["ac-cardholder", instanceId, cardholder.cardholder_id] });
  };

  const create = useMutation({
    mutationFn: () =>
      gates.cardholders.create(instanceId, {
        first_name: form.first_name.trim() || undefined,
        last_name: form.last_name.trim(),
        employee_id: form.employee_id.trim() || undefined,
        email: form.email.trim() || undefined,
        description: form.description.trim() || undefined,
        pin_code: form.pin_code.trim() || undefined,
        access_groups: groupIds,
        valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : undefined,
        valid_until: form.valid_until ? new Date(form.valid_until).toISOString() : undefined,
      }),
    onSuccess: () => {
      toast.success("Cardholder created");
      invalidate();
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Create failed")),
  });

  const update = useMutation({
    mutationFn: () => {
      const body = {};
      if (form.first_name !== (cardholder.first_name || "")) body.first_name = form.first_name.trim() || null;
      if (form.last_name !== (cardholder.last_name || "")) body.last_name = form.last_name.trim() || null;
      if (form.employee_id !== (cardholder.employee_id || "")) body.employee_id = form.employee_id.trim() || null;
      if (form.email !== (cardholder.email || "")) body.email = form.email.trim() || null;
      if (form.description !== (cardholder.description || "")) body.description = form.description.trim() || null;
      if (form.pin_code !== (cardholder.pin_code || "")) body.pin_code = form.pin_code.trim() || null;
      if (JSON.stringify(groupIds) !== JSON.stringify(cardholder.access_groups || [])) body.access_groups = groupIds;
      const vf = form.valid_from ? new Date(form.valid_from).toISOString() : null;
      const vu = form.valid_until ? new Date(form.valid_until).toISOString() : null;
      if (vf !== (cardholder.valid_from || null)) body.valid_from = vf;
      if (vu !== (cardholder.valid_until || null)) body.valid_until = vu;
      return gates.cardholders.update(instanceId, cardholder.cardholder_id, body);
    },
    onSuccess: () => {
      toast.success("Cardholder updated");
      invalidate();
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Update failed")),
  });

  const addCard = useMutation({
    mutationFn: () => gates.cardholders.addCard(instanceId, cardholder.cardholder_id, newCardId.trim()),
    onSuccess: () => {
      setNewCardId("");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e, "Add card failed")),
  });

  const removeCard = useMutation({
    mutationFn: (cardId) => gates.cardholders.removeCard(instanceId, cardholder.cardholder_id, cardId),
    onSuccess: invalidate,
    onError: (e) => toast.error(apiError(e, "Remove card failed")),
  });

  const liveCardholderQ = useQuery({
    queryKey: ["ac-cardholder", instanceId, cardholder?.cardholder_id],
    queryFn: () => gates.cardholders.get(instanceId, cardholder.cardholder_id),
    enabled: isEdit && !!instanceId,
  });
  const cards = useMemo(
    () => liveCardholderQ.data?.cards || cardholder?.cards || [],
    [liveCardholderQ.data, cardholder],
  );

  const validate = () => {
    const next = {};
    if (!form.last_name.trim()) next.last_name = "Required";
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) next.email = "Invalid email";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    if (isEdit) update.mutate();
    else create.mutate();
  };

  const isPending = create.isPending || update.isPending;
  const displayName = isEdit
    ? `${cardholder.first_name ? cardholder.first_name + " " : ""}${cardholder.last_name || cardholder.name || ""}`
    : "";

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit · ${displayName}` : "New Cardholder"}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-cardholder-form" variant="success" disabled={isPending}>
            {isPending ? "Saving…" : isEdit ? "Save changes" : "Create cardholder"}
          </Button>
        </>
      }
    >
      <form id="ac-cardholder-form" noValidate onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First Name" value={form.first_name} onChange={(e) => set({ first_name: e.target.value })} placeholder="e.g. Priya" />
          <Field label="Last Name" required value={form.last_name} onChange={(e) => set({ last_name: e.target.value })} placeholder="e.g. Sharma" error={errors.last_name} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Employee ID" value={form.employee_id} onChange={(e) => set({ employee_id: e.target.value })} placeholder="EMP-1234" />
          <Field label="Email" type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} error={errors.email} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="PIN Code" value={form.pin_code} onChange={(e) => set({ pin_code: e.target.value })} placeholder="optional" />
          <Field label="Description" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="optional" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from" type="datetime-local" value={form.valid_from} onChange={(e) => set({ valid_from: e.target.value })} />
          <Field label="Valid until" type="datetime-local" value={form.valid_until} onChange={(e) => set({ valid_until: e.target.value })} />
        </div>

        <div>
          <FieldLabel>Access Groups</FieldLabel>
          <GroupSelector allGroups={groups} selected={groupIds} onChange={setGroupIds} />
        </div>

        {isEdit && (
          <div className="rounded-lg border border-card-border p-3">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Cards ({cards.length})</div>
            {cards.length > 0 && (
              <ul className="mb-2 space-y-1">
                {cards.map((c) => (
                  <li key={c.card_id} className="flex items-center justify-between rounded bg-hover px-2 py-1.5 text-xs">
                    <span className="font-mono text-muted">{c.card_id}</span>
                    <button
                      type="button"
                      onClick={() => removeCard.mutate(c.card_id)}
                      disabled={removeCard.isPending}
                      className="rounded p-1 text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      title="Remove card"
                    >
                      <Icon icon="heroicons-outline:x-mark" className="text-xs" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <input
                value={newCardId}
                onChange={(e) => setNewCardId(e.target.value)}
                placeholder="Card code (e.g. 0123456)"
                className="flex-1 rounded-md border border-field bg-transparent px-2 py-1 text-xs text-foreground placeholder:text-muted outline-none focus:border-muted"
              />
              <Button
                type="button"
                variant="success"
                icon="heroicons-outline:plus"
                className="!px-2 !py-1 !text-xs"
                disabled={!newCardId.trim() || addCard.isPending}
                onClick={() => addCard.mutate()}
              >
                Add
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

function GroupSelector({ allGroups, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const idSet = new Set(selected);
  const selectedGroups = allGroups.filter((g) => idSet.has(g.group_id));

  return (
    <div className="mt-1">
      <div className="mb-1 flex flex-wrap gap-1">
        {selectedGroups.length === 0 ? (
          <span className="text-[11px] text-muted/70">No groups assigned</span>
        ) : (
          selectedGroups.map((g) => (
            <span key={g.group_id} className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-500">
              {g.name}
              <button type="button" onClick={() => onChange(selected.filter((id) => id !== g.group_id))} className="hover:text-red-500">
                <Icon icon="heroicons-outline:x-mark" className="text-xs" />
              </button>
            </span>
          ))
        )}
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-[11px] font-medium text-blue-500 hover:underline">
        {open ? "Done" : "+ Assign group"}
      </button>
      {open && (
        <div className="mt-2 max-h-40 overflow-y-auto rounded-md border border-card-border">
          {allGroups.length === 0 ? (
            <div className="p-2 text-center text-[11px] text-muted/70">No groups defined yet</div>
          ) : (
            allGroups.map((g) => {
              const checked = idSet.has(g.group_id);
              return (
                <label key={g.group_id} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (e.target.checked) onChange([...selected, g.group_id]);
                      else onChange(selected.filter((id) => id !== g.group_id));
                    }}
                  />
                  <span className="text-muted">{g.name}</span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
