"use client";

// PatternFormModal — create/edit a Pattern: name, description, a checkbox
// multi-select of camera GROUPS in rotation, dwell seconds (1–3600), and an
// active toggle. On save it POSTs/PATCHes { name, description, camera_group_ids,
// seconds, is_active } to /vms/patterns. Uses the shared Modal (fits comfortably).
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { getGroupLayout } from "../videoWall";

export default function PatternFormModal({ open, pattern, groups = [], onClose, onSaved }) {
  const qc = useQueryClient();
  const isEdit = !!pattern;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [seconds, setSeconds] = useState(10);
  const [groupIds, setGroupIds] = useState([]);
  const [isActive, setIsActive] = useState(true);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (!open) return;
    setName(pattern?.name || "");
    setDescription(pattern?.description || "");
    setSeconds(pattern?.seconds ?? 10);
    setGroupIds(pattern?.camera_group_ids || []);
    setIsActive(pattern?.is_active !== false);
    setErrors({});
  }, [open, pattern]);

  const save = useMutation({
    mutationFn: (body) =>
      isEdit ? vms.patterns.update(pattern.id, body) : vms.patterns.create(body),
    onSuccess: () => {
      toast.success(`Pattern ${isEdit ? "updated" : "created"}`);
      qc.invalidateQueries({ queryKey: ["vms-patterns"] });
      onSaved?.();
      onClose?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  function toggleGroup(id) {
    setGroupIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function submit() {
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 1 || s > 3600) next.seconds = "Dwell must be 1–3600 seconds";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      seconds: s,
      camera_group_ids: groupIds,
      is_active: isActive,
    });
  }

  return (
    <Modal
      open={open}
      onClose={save.isPending ? undefined : onClose}
      wide
      title={isEdit ? "Edit pattern" : "New pattern"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create pattern"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Perimeter sweep"
          maxLength={100}
          error={errors.name}
        />
        <Field
          label="Description"
          as="textarea"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional"
        />

        <div className="flex flex-wrap items-end justify-between gap-4">
          <Field
            label="Dwell per group (seconds)"
            type="number"
            min={1}
            max={3600}
            value={seconds}
            onChange={(e) => {
              setSeconds(e.target.value);
              if (errors.seconds) setErrors((p) => ({ ...p, seconds: undefined }));
            }}
            className="w-40"
            containerClassName="w-44"
            error={errors.seconds}
          />
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Toggle checked={isActive} onChange={setIsActive} />
            <span className="text-muted">Active</span>
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between pb-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">
              Camera groups in rotation
            </span>
            <span className="text-[11px] text-muted">{groupIds.length} selected</span>
          </div>
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-card-border px-3 py-6 text-center text-xs text-muted">
              No camera groups yet — create one from the Camera Groups tab first.
            </div>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-card-border p-1.5">
              {groups.map((g) => {
                const checked = groupIds.includes(g.id);
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition ${
                        checked
                          ? "border-blue-500/50 bg-blue-500/10"
                          : "border-transparent hover:bg-hover"
                      }`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          checked ? "border-blue-500 bg-blue-500 text-white" : "border-card-border"
                        }`}
                      >
                        {checked && <Icon icon="heroicons-mini:check" className="text-[11px]" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{g.name}</span>
                        <span className="block text-[11px] text-muted">
                          {(g.camera_ids || []).length} cameras · {getGroupLayout(g.layout).label}
                        </span>
                      </span>
                      {g.is_active === false && (
                        <span className="shrink-0 rounded-full bg-hover px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted">
                          Inactive
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-1.5 text-[11px] text-muted/70">
            The wall cycles through these groups in order, dwelling {Number(seconds) || 0}s on each.
          </p>
        </div>
      </div>
    </Modal>
  );
}
