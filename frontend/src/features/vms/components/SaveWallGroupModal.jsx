"use client";

// SaveWallGroupModal — one-click "save the current video wall as a reusable Camera
// Group" straight from the streaming wall, so operators don't have to rebuild the
// same arrangement in Config → Patterns → Camera Groups (fewer clicks, less
// confusion). Captures the wall's cameras (ordered) + layout (mapped to a group
// layout) and POSTs a CameraGroup. That group is then available in the inline
// "New pattern" flow to build a rotation without leaving the wall.
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Input, Modal } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import { wallLayoutToGroup } from "../videoWall";

export default function SaveWallGroupModal({ open, layoutKey, cameraIds = [], onClose, onSaved }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const save = useMutation({
    mutationFn: () =>
      vms.groups.create({
        name: name.trim(),
        description: description.trim() || null,
        layout: wallLayoutToGroup(layoutKey),
        camera_ids: cameraIds,
      }),
    onSuccess: () => {
      toast.success(`Camera group “${name.trim()}” saved`);
      onSaved?.();
    },
    onError: (e) => toast.error(apiError(e, "Could not save group")),
  });

  const canSave = !!name.trim() && cameraIds.length > 0 && !save.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save wall as camera group"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? "Saving…" : "Save group"}
          </Button>
        </>
      }
    >
      <Input
        label="Group name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Ground floor overview"
        autoFocus
        onKeyDown={(e) => e.key === "Enter" && canSave && save.mutate()}
      />
      <Input
        label="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What this group covers"
        className="mt-3"
      />
      <p className="mt-3 text-xs text-muted">
        Saves the {cameraIds.length} camera{cameraIds.length === 1 ? "" : "s"} on the wall and this
        layout as a reusable group. Add it to a Pattern to rotate the wall automatically.
      </p>
    </Modal>
  );
}
