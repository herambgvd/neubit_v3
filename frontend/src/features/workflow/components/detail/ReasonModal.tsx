"use client";

// Reason-capture modal for escalate / resolve / cancel actions. The `action`
// carries a title + verb + a run(reason) callback; submitting passes the trimmed
// reason (or null) to onSubmit.
import { useState } from "react";
import { Button, Modal } from "@/components/ui/kit";

/** What the reason modal is collecting a reason FOR. */
export interface ReasonAction {
  title: string;
  verb: string;
  run: (reason: string | null) => void;
}

export interface ReasonModalProps {
  action: ReasonAction;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string | null) => void;
}

export default function ReasonModal({ action, pending, onCancel, onSubmit }: ReasonModalProps) {
  const [reason, setReason] = useState("");
  return (
    <Modal
      open
      onClose={onCancel}
      title={action.title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>Cancel</Button>
          <Button onClick={() => onSubmit(reason.trim() || null)} disabled={pending}>
            {pending ? "Working…" : action.verb}
          </Button>
        </>
      }
    >
      <label className="text-xs font-medium uppercase tracking-wide text-muted" htmlFor="reason-modal-reason">Reason (optional)</label>
      <textarea
        id="reason-modal-reason"
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
        className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-hidden focus:border-muted"
        placeholder="Add context for this action"
      />
    </Modal>
  );
}
