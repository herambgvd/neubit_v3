"use client";

import { Icon } from "@iconify/react";

import { Button, Modal, PasswordInput } from "@/components/ui/kit";

// Delete user — requires the admin to re-enter their password.
export default function DeleteUserModal({ deleting, onClose, password, setPassword, onConfirm, removing }: any) {
  return (
    <Modal
      open={!!deleting}
      onClose={onClose}
      staticBackdrop
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
        <div className="flex items-start gap-2 rounded-[9px] border border-[rgba(248,113,113,.3)] bg-[rgba(248,113,113,.1)] px-3 py-2.5 text-sm text-nb-crit">
          <Icon icon="heroicons-outline:exclamation-triangle" className="text-base mt-0.5 shrink-0" />
          <span>
            This permanently deletes <strong>{deleting?.email}</strong> and revokes their access. This
            cannot be undone.
          </span>
        </div>
        <PasswordInput
          label="Confirm your password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your account password"
          hint="Re-enter your own password to authorize this deletion."
        />
      </div>
    </Modal>
  );
}
