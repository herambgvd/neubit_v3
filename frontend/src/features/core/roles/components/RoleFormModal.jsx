"use client";

import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";
import PermissionSelector from "./PermissionSelector";

export default function RoleFormModal({
  open,
  onClose,
  editing,
  readOnly,
  form,
  setForm,
  groups,
  selected,
  catalogLoading,
  onToggleKey,
  onToggleGroup,
  onSave,
  saving,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      hideScroll
      title={editing ? (readOnly ? `${editing.name} (system role)` : `Edit role`) : "Create role"}
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant={editing ? "primary" : "success"} disabled={saving || !form.name} onClick={onSave}>
              {saving ? "Saving…" : editing ? "Save changes" : "Create"}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-5">
        {readOnly && (
          <div className="flex items-center gap-2 rounded-[10px] border border-[rgba(96,165,250,.4)] bg-[rgba(96,165,250,.1)] px-3 py-2 text-sm text-nb-blueb">
            <Icon icon="heroicons-outline:lock-closed" className="text-base" />
            System roles are built in and cannot be edited.
          </div>
        )}

        <Input
          label="Name"
          value={form.name}
          disabled={readOnly}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Enter role name (e.g. Operator)"
        />
        <Input
          label="Description"
          value={form.description}
          disabled={readOnly}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder="Enter a short description of what this role can do"
        />

        <PermissionSelector
          groups={groups}
          selected={selected}
          loading={catalogLoading}
          readOnly={readOnly}
          count={form.permissions.length}
          onToggleKey={onToggleKey}
          onToggleGroup={onToggleGroup}
        />
      </div>
    </Modal>
  );
}
