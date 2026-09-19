"use client";

// GATE 6 · ACTS — the other end. The finding cleared; the work did not.
//
// WHY A PRESS AND NOT AN AUTOMATION. A sensor that reports again, or an alert
// somebody acknowledged on the gateway, says the READING changed. It does not
// say the job is done: the sensor may have been unplugged and replugged, the
// alarm may clear every night at the same hour. Closing the incident is a
// person's statement about the plant, so a person makes it, and the incident
// carries what they said rather than a sentence this console composed.
//
// The note is REQUIRED for the same reason the starter playbooks require one on
// every closing transition: an incident with no account of what happened is a
// row that teaches nobody anything a month later.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ActionButton, QuietButton } from "@/components/console";
import { Modal } from "@/components/ui/kit";
import { useAuth } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { workflow } from "@/features/workflow/api";
import type { OpenWork } from "@/features/workflow/types";

import type { Finding } from "../findings";

export const PERM_CLOSE = "workflow.instance.update";

export default function CloseWork({
  finding,
  work,
  open,
  onClose,
}: Readonly<{ finding: Finding; work: OpenWork; open: boolean; onClose: () => void }>) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const close = useMutation({
    mutationFn: () => workflow.instances.setStatus(work.instance_id, "resolved", note.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bi-open-work"] });
      qc.invalidateQueries({ queryKey: ["workflow-instances"] });
      onClose();
    },
    onError: (e) => setErr(apiError(e, "Could not close the work")),
  });

  const mayClose = can(PERM_CLOSE);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close this work"
      size="wide"
      staticBackdrop
      footer={
        <>
          <QuietButton onClick={onClose}>Cancel</QuietButton>
          {mayClose ? (
            <ActionButton onClick={() => close.mutate()} disabled={!note.trim() || close.isPending}>
              {close.isPending ? "Closing…" : note.trim() ? "Close as resolved" : "Write what happened"}
            </ActionButton>
          ) : null}
        </>
      }
    >
      <div className="grid gap-3">
        <div className="rounded-lg border border-nb-line bg-nb-sunk p-3 text-sm">
          <div className="font-medium">
            {finding.equipment_tag ? `${finding.equipment_tag} · ` : ""}
            {finding.title}
          </div>
          {/* What CHANGED, in the store's own words — and no claim beyond it. */}
          <p className="mt-1 text-[12px] text-nb-muted">
            {finding.kind === "alert"
              ? "The alert has been acknowledged on the gateway."
              : "The reading this work was raised about is being produced again."}{" "}
            The incident <span className="font-medium">{work.name}</span> is still open.
          </p>
        </div>
        {mayClose ? (
          <label className="grid gap-1 text-[12px]">
            <span className="text-nb-muted">What happened (required)</span>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Replaced the sensor's power supply; it has reported for two hours since."
              className="rounded-md border border-nb-line bg-nb-sunk px-2.5 py-2 text-sm outline-none focus:border-nb-accent"
            />
          </label>
        ) : (
          <p className="text-[12px] text-nb-muted">Closing work needs {PERM_CLOSE}.</p>
        )}
        {err ? <p className="text-[12px] text-rose-300">{err}</p> : null}
      </div>
    </Modal>
  );
}
