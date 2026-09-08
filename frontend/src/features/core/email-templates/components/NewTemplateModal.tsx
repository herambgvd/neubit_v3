"use client";

// Create a custom email template.
//
// IT SAYS WHAT IT IS. Nothing in the product sends a custom template today — the
// three built-ins are named by the code that sends them. So this dialog states
// that plainly rather than letting an admin build an email that is never
// delivered and find out later. The rest of the plumbing (list, edit, preview,
// delete) treats it exactly like a built-in.
import { useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";

/** The server's own rule (messaging/router.py) — checked here so it is caught
 *  before the round trip, not instead of it. */
const NAME_RE = /^[a-z][a-z0-9_]{1,48}$/;

export interface NewTemplateModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, subject: string) => void;
  /** Names already taken — a built-in or an existing custom one. */
  taken: string[];
  creating?: boolean;
}

export default function NewTemplateModal({
  open,
  onClose,
  onCreate,
  taken,
  creating,
}: NewTemplateModalProps) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const trimmed = name.trim().toLowerCase();
  const error = !trimmed
    ? "A name is required."
    : !NAME_RE.test(trimmed)
      ? "Lower-case letters, digits and underscores only — start with a letter."
      : taken.includes(trimmed)
        ? "A template with that name already exists."
        : "";

  function submit() {
    setSubmitted(true);
    if (error) return;
    onCreate(trimmed, subject.trim() || trimmed.replace(/_/g, " "));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="New template"
      subtitle="A custom transactional email."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={creating} onClick={submit}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-[10px] border border-nb-warn/30 bg-nb-warn/10 px-3 py-2.5 text-[12px] text-nb-warn">
          <Icon icon="heroicons:exclamation-triangle" className="mt-0.5 shrink-0 text-sm" />
          <span>
            Nothing sends a custom template yet. The three built-ins are named by the code
            that sends them — this one is editable and previewable, but it will not be
            delivered until something references it by name.
          </span>
        </div>

        <Input
          label="Name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="maintenance_notice"
          hint="How the sender will refer to it. Lower-case, underscores, no spaces."
          error={submitted ? error : undefined}
        />
        <Input
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Scheduled maintenance"
          hint="You can change this, and design the body, straight after."
        />
      </div>
    </Modal>
  );
}
