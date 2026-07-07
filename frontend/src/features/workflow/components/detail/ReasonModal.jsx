"use client";

// Reason-capture modal for escalate / resolve / cancel actions. The `action`
// carries a title + verb + a run(reason) callback; submitting passes the trimmed
// reason (or null) to onSubmit.
import { useState } from "react";
import { Button, Modal } from "@/components/ui/kit";

export default function ReasonModal({ action, pending, onCancel, onSubmit }) {
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
      <label className="text-xs font-medium uppercase tracking-wide text-muted">Reason (optional)</label>
      <textarea
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
        className="mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-muted"
        placeholder="Add context for this action"
      />
    </Modal>
  );
}
