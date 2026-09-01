"use client";

import { useEffect, useState } from "react";

import { Button, Input, Modal } from "@/components/ui/kit";
import { roleNameError } from "../validation";

// Copy a role's permissions under a new name — a fast starting point you then trim
// down. Lives in its own file (rather than inline in Roles.jsx) so it matches
// CloneUserModal: the two clone dialogs are the same dialog with different nouns.
export default function CloneRoleModal({ source, onClose, name, setName, onClone, cloning }: any) {
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!source) setSubmitted(false); }, [source]);

  const error = roleNameError(name);

  function handleClone() {
    setSubmitted(true);
    if (error) return;
    onClone();
  }

  return (
    <Modal
      open={!!source}
      onClose={onClose}
      staticBackdrop
      title={source ? `Clone ${source.name}` : "Clone role"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="action" disabled={cloning} onClick={handleClone}>
            {cloning ? "Cloning…" : "Create clone"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-[9px] border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.07)] px-3 py-2.5 text-xs text-nb-soft">
          Copies all of <b className="text-nb-blueb">{source?.name}</b>&rsquo;s permissions under a new
          name — a fast starting point you can then trim down.
        </div>
        <Input
          label="New role name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter new role name (e.g. SOC Operator — night shift)"
          error={submitted ? error : undefined}
        />
      </div>
    </Modal>
  );
}
