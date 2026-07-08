"use client";

// Create / edit an access group scoped to the instance. Ported from neubit_v2's
// access-group-modal.jsx: name (required), schedule select (always-allowed by
// default), description, and a checkbox list of instance doors. On edit it refetches
// the latest group to hydrate the form. Rethemed to v3 tokens.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";

export default function AccessGroupModal({ instanceId, group, onClose, onSuccess }) {
  const isEdit = !!group;
  const qc = useQueryClient();

  const groupQ = useQuery({
    queryKey: ["ac-access-group", instanceId, group?.group_id],
    queryFn: () => gates.accessGroups.get(instanceId, group.group_id),
    enabled: isEdit && !!instanceId,
    staleTime: 30_000,
  });
  const editGroup = groupQ.data || group;

  const [form, setForm] = useState({
    name: group?.name || "",
    description: group?.description || "",
    schedule_id: group?.schedule_id || "",
  });
  const [doorIds, setDoorIds] = useState(group?.door_ids || []);
  const [errors, setErrors] = useState({});

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!editGroup) return;
    setForm({
      name: editGroup.name || "",
      description: editGroup.description || "",
      schedule_id: editGroup.schedule_id || "",
    });
    setDoorIds(editGroup.door_ids || []);
  }, [editGroup]);

  const doorsQ = useQuery({
    queryKey: ["ac-doors", instanceId],
    queryFn: () => gates.doors.list({ instance_id: instanceId, limit: 500 }),
    enabled: !!instanceId,
  });
  const doors = asItems(doorsQ.data);

  const schedulesQ = useQuery({
    queryKey: ["ac-schedules", instanceId],
    queryFn: () => gates.schedules.list(instanceId),
    enabled: !!instanceId,
  });
  const schedules = asItems(schedulesQ.data);

  const m = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        door_ids: doorIds,
        schedule_id: form.schedule_id || null,
      };
      return isEdit ? gates.accessGroups.update(instanceId, group.group_id, body) : gates.accessGroups.create(instanceId, body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Group updated" : "Group created");
      qc.invalidateQueries({ queryKey: ["ac-access-groups", instanceId] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = "Required";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e) => {
    e.preventDefault();
    if (validate()) m.mutate();
  };

  const idSet = useMemo(() => new Set(doorIds), [doorIds]);
  const selectedCount = doors.filter((d) => idSet.has(d.door_id)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit · ${editGroup?.name || group.name}` : "New Access Group"}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="ac-group-form" variant="success" disabled={m.isPending}>
            {m.isPending ? "Saving…" : isEdit ? "Save changes" : "Create group"}
          </Button>
        </>
      }
    >
      <form id="ac-group-form" noValidate onSubmit={submit} className="space-y-4">
        {isEdit && groupQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Icon icon="svg-spinners:180-ring" className="text-sm" /> Loading latest group...
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. HQ — Day shift" error={errors.name} />
          <Field
            as="select"
            label="Schedule"
            value={form.schedule_id}
            onChange={(e) => set({ schedule_id: e.target.value })}
            options={[{ value: "", label: "— Always allowed —" }, ...schedules.map((s) => ({ value: s.schedule_id, label: s.name }))]}
          />
        </div>

        <Field label="Description" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="Optional" />

        <div>
          <FieldLabel>Doors ({selectedCount})</FieldLabel>
          {doors.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted/70">No doors found for this controller — sync first.</p>
          ) : (
            <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-card-border">
              {doors.map((d) => {
                const checked = idSet.has(d.door_id);
                return (
                  <label key={d.door_id} className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-hover ${checked ? "bg-blue-500/5" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setDoorIds([...doorIds, d.door_id]);
                        else setDoorIds(doorIds.filter((id) => id !== d.door_id));
                      }}
                    />
                    <span className="font-medium text-muted">{d.name}</span>
                    {d.access_level && <span className="text-[10px] text-muted/70">{d.access_level}</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
