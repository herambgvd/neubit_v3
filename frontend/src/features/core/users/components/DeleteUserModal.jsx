"use client";

import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";

// Delete user — requires the admin to re-enter their password.
export default function DeleteUserModal({ deleting, onClose, password, setPassword, onConfirm, removing }) {
  return (
    <Modal
      open={!!deleting}
      onClose={onClose}
      title="Delete user"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={removing || !password} onClick={onConfirm}>
            {removing ? "Deleting…" : "Delete user"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-500">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-base mt-0.5 shrink-0" />
          <span>
            This permanently deletes <strong>{deleting?.email}</strong> and revokes their access. This
            cannot be undone.
          </span>
        </div>
        <Input
          label="Confirm your password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Your account password"
          hint="Re-enter your own password to authorize this deletion."
        />
      </div>
    </Modal>
  );
}
