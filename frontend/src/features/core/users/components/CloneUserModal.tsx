"use client";

import { Button, Input, Modal, Toggle } from "@/components/ui/kit";

// Fast onboarding: clone a source user's role, status and site scope into a new
// account. Only identity is entered here — the backend copies everything else and
// never copies a password (the new user sets their own via the emailed invite).
export default function CloneUserModal({ source, onClose, form, setForm, onClone, cloning }: any) {
  return (
    <Modal
      open={!!source}
      onClose={onClose}
      staticBackdrop
      title={source ? `Clone ${source.full_name || source.email}` : "Clone user"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="action" disabled={cloning || !form.email} onClick={onClone}>
            {cloning ? "Cloning…" : "Create clone"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-[9px] border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.07)] px-3 py-2.5 text-xs text-nb-soft">
          Inherits <b className="text-nb-blueb">{source?.role?.name}</b>&rsquo;s permissions, the
          account status and site scope. No password is copied — the new user sets their own.
        </div>
        <Input
          label="Full name"
          value={form.full_name}
          onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          placeholder="Enter full name"
        />
        <Input
          label="Email · sign-in"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="Enter email address"
        />
        <div className="flex items-center justify-between rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-nb-ink">Send invite email</div>
            <div className="text-xs text-nb-faint">Secure link to set their own password.</div>
          </div>
          <Toggle checked={form.send_invite} onChange={(v) => setForm({ ...form, send_invite: v })} />
        </div>
      </div>
    </Modal>
  );
}
