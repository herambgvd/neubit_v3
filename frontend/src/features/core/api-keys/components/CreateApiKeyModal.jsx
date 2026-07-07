"use client";

import { Button, Input, Modal, Select } from "@/components/ui/kit";

export default function CreateApiKeyModal({ open, onClose, form, setForm, roleOptions, onCreate, creating }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create API key"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="success"
            disabled={creating || !form.name || !form.role_id}
            onClick={onCreate}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="e.g. Production integration"
        />
        <Select
          label="Role"
          value={form.role_id}
          options={[{ value: "", label: "Select a role…" }, ...roleOptions]}
          onChange={(e) => setForm({ ...form, role_id: e.target.value })}
        />
      </div>
    </Modal>
  );
}
