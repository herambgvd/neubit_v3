"use client";

import { Button, Input, Modal, Select, Toggle } from "@/components/ui/kit";

export default function AddUserModal({ open, onClose, form, setForm, roleOptions, onCreate, creating }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add user"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="success"
            disabled={creating || !form.email || !form.password || !form.role_id}
            onClick={onCreate}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input label="Full name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Jane Doe" />
        <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@example.com" />
        <Input label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} hint="At least 8 characters, with a letter and a number." />
        <Select
          label="Role"
          value={form.role_id}
          options={[{ value: "", label: "Select a role…" }, ...roleOptions]}
          onChange={(e) => setForm({ ...form, role_id: e.target.value })}
        />
        <div className="flex items-center justify-between rounded-lg border border-card-border px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-foreground">Send invite email</div>
            <div className="text-xs text-muted">
              Emails a welcome message + a secure link to set their password.
            </div>
          </div>
          <Toggle
            checked={form.send_invite}
            onChange={(v) => setForm({ ...form, send_invite: v })}
          />
        </div>
      </div>
    </Modal>
  );
}
