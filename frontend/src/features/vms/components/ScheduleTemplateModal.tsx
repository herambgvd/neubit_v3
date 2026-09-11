"use client";

// NAME A SCHEDULE. Create or rename — the WEEK itself is painted on the screen
// behind this, not in a dialog.
//
// That split is deliberate. A 7×24 grid inside a modal is either too small to
// paint or a modal the size of the page, and both are worse than the page itself.
// So creating asks only for the two things a grid cannot carry — a name and a
// sentence about when it is for — and drops you on the painter.
//
// A NEW TEMPLATE IS NOT BORN EMPTY. The recorder refuses a document with no
// recording in it (a template whose whole job is to set a schedule must carry
// one), so "create" would fail on an empty week with a validation error about a
// shape the operator never chose. It starts as weekdays 09:00-18:00 — the
// commonest week in the building, and visible on the painter the moment the dialog
// closes, so it reads as a starting point rather than as something we decided.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Input, Modal, Textarea } from "@/components/ui/kit";
import { apiError } from "@/lib/api";
import { vms } from "../api";
import type { ScheduleTemplate } from "../types";
import { emptyWeek, weekToDoc, type Week } from "./weekSchedule";

export interface ScheduleTemplateModalProps {
  nodeId: string;
  /** null = create. */
  template?: ScheduleTemplate | null;
  /** The week a NEW template starts with; ignored when renaming. */
  defaultWeek?: Week | null;
  onClose?: () => void;
  onSaved?: (saved: ScheduleTemplate) => void;
}

/** Weekdays 09:00–18:00, continuous. Not a policy — a first draft that is quicker
 *  to erase than to paint from nothing. */
export function starterWeek(): Week {
  const week = emptyWeek();
  for (let d = 0; d < 5; d++) for (let h = 9; h < 18; h++) week[d][h] = "record";
  return week;
}

export default function ScheduleTemplateModal({
  nodeId,
  template,
  defaultWeek,
  onClose,
  onSaved,
}: ScheduleTemplateModalProps) {
  const isEdit = !!template;
  // Seeded once, from the template being edited. The caller MOUNTS this dialog when
  // it opens rather than keeping it around hidden, so there is nothing to reset —
  // an effect that copies props into state on every open is the same thing said
  // less directly, and it renders once with the previous template's name.
  const [name, setName] = useState(() => template?.name ?? "");
  const [description, setDescription] = useState(() => template?.description ?? "");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (): Promise<ScheduleTemplate> => {
      const trimmed = name.trim();
      if (isEdit) {
        // A rename must carry the week back UNCHANGED. The node's PUT replaces the
        // template, so sending no schedule here would blank the one being renamed.
        return vms.federation.schedules.update(nodeId, template!.id, {
          name: trimmed,
          description: description.trim(),
          schedule: template!.schedule ?? weekToDoc(starterWeek()),
        });
      }
      return vms.federation.schedules.create(nodeId, {
        name: trimmed,
        description: description.trim(),
        schedule: weekToDoc(defaultWeek?.some((r) => r.some((s) => s !== "off")) ? defaultWeek : starterWeek()),
      });
    },
    onSuccess: (saved) => {
      toast.success(isEdit ? "Schedule renamed" : "Schedule created", {
        description: isEdit ? undefined : "Paint the week, then apply it to cameras.",
      });
      onSaved?.(saved);
    },
    onError: (e) => setError(apiError(e)),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? "Rename schedule" : "New schedule"}
      subtitle={
        isEdit
          ? "The week is unchanged — paint it on the screen behind."
          : "Name it, then paint the week. It starts on weekdays 09:00–18:00."
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : isEdit ? "Rename" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Input
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Business hours"
        />
        <Textarea
          label="When this is for"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Weekdays only — the loading bay is staffed 09:00–18:00"
        />
        {error && <p className="text-[12px] text-nb-crit">{error}</p>}
      </div>
    </Modal>
  );
}
