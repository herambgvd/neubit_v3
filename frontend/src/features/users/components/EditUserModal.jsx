"use client";

import { Button, Input, Modal, Select, Toggle } from "@/components/ui/kit";

export default function EditUserModal({ editing, onClose, form, setForm, roleOptions, onSave, saving }) {
  return (
    <Modal
      open={!!editing}
      onClose={onClose}
      title={`Edit ${editing?.email || "user"}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving} onClick={onSave}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Full name"
          value={form.full_name}
          onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          placeholder="Jane Doe"
        />
        <Select
          label="Role"
          value={form.role_id}
          options={roleOptions}
          onChange={(e) => setForm({ ...form, role_id: e.target.value })}
        />
        <div className="flex items-center justify-between rounded-lg border border-card-border px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-foreground">Active</div>
            <div className="text-xs text-muted">Disabled users cannot sign in.</div>
          </div>
          <Toggle
            checked={form.is_active}
            onChange={(v) => setForm({ ...form, is_active: v })}
          />
        </div>
      </div>
    </Modal>
  );
}
