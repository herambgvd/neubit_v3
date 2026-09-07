"use client";

// Create / edit an access group scoped to the instance. Ported from neubit_v2's
// access-group-modal.jsx: name (required), schedule select (always-allowed by
// default), description, and a checkbox list of instance doors. On edit it refetches
// the latest group to hydrate the form. Rethemed to v3 tokens.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import { asItems } from "@/lib/format";
import { gates } from "../api";
import type { AccessGroupPublic } from "../types";

/** The three scalar fields; the door selection is its own state. */
interface AccessGroupForm {
  name: string;
  description: string;
  /** "" = always allowed (no schedule). */
  schedule_id: string;
}

export interface AccessGroupModalProps {
  instanceId: string;
  /** The row being edited; omit/null to create. */
  group?: AccessGroupPublic | null;
  onClose: () => void;
  onSuccess?: () => void;
}

export default function AccessGroupModal({ instanceId, group, onClose, onSuccess }: AccessGroupModalProps) {
  const isEdit = !!group;
  const qc = useQueryClient();

  const groupQ = useQuery({
    queryKey: ["ac-access-group", instanceId, group?.group_id],
    // `enabled: isEdit` below — the query only runs when `group` is set.
    queryFn: () => gates.accessGroups.get(instanceId, group!.group_id),
    enabled: isEdit && !!instanceId,
    staleTime: 30_000,
  });
  const editGroup = groupQ.data || group;

  const [form, setForm] = useState<AccessGroupForm>({
    name: group?.name || "",
    description: group?.description || "",
    schedule_id: group?.schedule_id || "",
  });
  // Local door ids (`AccessDoorPublic.id`), which is what the catalog stores.
  const [doorIds, setDoorIds] = useState<string[]>(group?.door_ids || []);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (patch: Partial<AccessGroupForm>) => setForm((f) => ({ ...f, ...patch }));

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
      // `group` set ⇔ isEdit, so this branch also narrows it for the id.
      return group ? gates.accessGroups.update(instanceId, group.group_id, body) : gates.accessGroups.create(instanceId, body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Group updated" : "Group created");
      qc.invalidateQueries({ queryKey: ["ac-access-groups", instanceId] });
      onSuccess?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  const validate = () => {
    const next: Record<string, string> = {};
    if (!form.name.trim()) next.name = "Required";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (validate()) m.mutate();
  };

  const idSet = useMemo(() => new Set<string>(doorIds), [doorIds]);
  const selectedCount = doors.filter((d) => idSet.has(d.id)).length;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? `Edit · ${editGroup?.name || group?.name}` : "New Access Group"}
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
                const checked = idSet.has(d.id);
                return (
                  <label key={d.id} className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-hover ${checked ? "bg-blue-500/5" : ""}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setDoorIds([...doorIds, d.id]);
                        else setDoorIds(doorIds.filter((id) => id !== d.id));
                      }}
                    />
                    <span className="font-medium text-muted">{d.name}</span>
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
