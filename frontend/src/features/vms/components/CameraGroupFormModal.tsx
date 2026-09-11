"use client";

// CameraGroupFormModal — create/edit a GROUP: name, description, grid
// layout, active toggle, and the camera-to-grid builder. Wider than the shared
// Modal (the builder needs room), so it's a portal-based sheet reusing the v3
// dark tokens. On save it POSTs/PATCHes { name, description, camera_ids, layout,
// is_active } to /vms/camera-groups.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { CameraGroupCreate, CameraGroupPublic, EstateCamera, GridLayout } from "../types";
import { GROUP_LAYOUTS, DEFAULT_GROUP_LAYOUT, getGroupLayout } from "../videoWall";
import GroupGridBuilder from "./GroupGridBuilder";

// The select's options come from GROUP_LAYOUTS, so a value it hands back is one
// of those keys; this narrows the string at that boundary.
const isGridLayout = (v: string): v is GridLayout => GROUP_LAYOUTS.some((l) => l.key === v);

export interface CameraGroupFormModalProps {
  open: boolean;
  /** null/undefined = create. */
  group?: CameraGroupPublic | null;
  cameras?: EstateCamera[];
  onClose?: () => void;
  onSaved?: (saved: CameraGroupPublic) => void;
}

interface GroupFormErrors {
  name?: string;
  cells?: string;
}

export default function CameraGroupFormModal({ open, group, cameras = [], onClose, onSaved }: CameraGroupFormModalProps) {
  const qc = useQueryClient();
  const isEdit = !!group;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [layout, setLayout] = useState<GridLayout>(DEFAULT_GROUP_LAYOUT);
  const [isActive, setIsActive] = useState(true);
  const [cells, setCells] = useState<(string | null)[]>([]);
  const [errors, setErrors] = useState<GroupFormErrors>({});

  useEffect(() => {
    if (!open) return;
    setName(group?.name || "");
    setDescription(group?.description || "");
    const lyt = group?.layout || DEFAULT_GROUP_LAYOUT;
    setLayout(lyt);
    setIsActive(group?.is_active !== false);
    const cap = getGroupLayout(lyt).capacity;
    const seed = Array.from({ length: cap }, (_, i) => group?.camera_ids?.[i] || null);
    setCells(seed);
    setErrors({});
  }, [open, group]);

  // Resize the builder cells when the layout changes (pad/truncate).
  const capacity = useMemo(() => getGroupLayout(layout).capacity, [layout]);
  useEffect(() => {
    setCells((cur) => {
      if (cur.length === capacity) return cur;
      if (cur.length > capacity) return cur.slice(0, capacity);
      return [...cur, ...Array.from({ length: capacity - cur.length }, () => null)];
    });
  }, [capacity]);

  const save = useMutation({
    mutationFn: (body: CameraGroupCreate) =>
      group ? vms.groups.update(group.id, body) : vms.groups.create(body),
    onSuccess: (saved) => {
      toast.success(`Group ${isEdit ? "updated" : "created"}`);
      qc.invalidateQueries({ queryKey: ["vms-camera-groups"] });
      qc.invalidateQueries({ queryKey: ["vms-groups"] });
      onSaved?.(saved);
      onClose?.();
    },
    onError: (e) => toast.error(apiError(e, "Save failed")),
  });

  // Escape closes it, matching kit's <Modal>. This one rolls its own backdrop, so
  // it took the click-away and left a keyboard user inside a dialog with no way
  // out. A save in flight holds it open, exactly as the backdrop click does —
  // the two dismissal routes must agree or Escape becomes the way to abandon a
  // write that is already running.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !save.isPending) onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, save.isPending]);


  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: GroupFormErrors = {};
    if (!name.trim()) next.name = "Name is required";
    const ids = cells.filter((c): c is string => !!c);
    if (ids.length === 0) next.cells = "Place at least one camera in the grid.";
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    save.mutate({
      name: name.trim(),
      description: description.trim() || null,
      layout,
      camera_ids: ids,
      is_active: isActive,
    });
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto p-4 py-[6vh]">
      {/* A <button>, like every other backdrop in the console — dismissing is an
          action. Out of the tab order and hidden from assistive tech because this
          dialog has its own close control and Escape, so a second announced
          "Close" would be two identical things to choose between. `disabled`
          carries the in-flight save: the two dismissal routes must agree, or the
          mouse can abandon a write the keyboard cannot. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        disabled={save.isPending}
        className="absolute inset-0 bg-black/60 backdrop-blur-xs animate-fade-in"
        onClick={() => onClose?.()}
      />
      <form
        onSubmit={submit}
        noValidate
        className="relative w-full max-w-4xl rounded-xl border border-card-border bg-card shadow-2xl animate-modal-in"
      >
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">
            {isEdit ? "Edit group" : "New group"}
          </h3>
          <button
            type="button"
            onClick={() => onClose?.()}
            className="text-muted transition hover:text-foreground"
          >
            <Icon icon="heroicons-outline:x-mark" className="text-xl" />
          </button>
        </div>

        <div className="max-h-[74vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field
              label="Name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lobby cameras"
              maxLength={100}
              error={errors.name}
            />
            <Field
              label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="flex flex-wrap items-end justify-between gap-4">
            <Field
              label="Grid layout"
              as="select"
              value={layout}
              onChange={(e) => {
                const v = e.target.value;
                if (isGridLayout(v)) setLayout(v);
              }}
              options={GROUP_LAYOUTS.map((l) => ({ value: l.key, label: l.label }))}
              className="w-36"
              containerClassName="w-36"
            />
            <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
              <Toggle checked={isActive} onChange={setIsActive} label="Active" />
              <span className="text-muted">Active</span>
            </label>
          </div>

          <GroupGridBuilder
            layout={layout}
            cameras={cameras}
            cells={cells}
            onChange={(next) => {
              setCells(next);
              if (errors.cells) setErrors((p) => ({ ...p, cells: undefined }));
            }}
            error={errors.cells}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-card-border px-5 py-4">
          <Button variant="secondary" type="button" onClick={() => onClose?.()} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : isEdit ? "Save changes" : "Create group"}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
