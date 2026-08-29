"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";
import PermissionSelector from "./PermissionSelector";
import { validateRole } from "../validation";

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
}: any) {
  // Same submit-then-validate flow as the Add/Edit user dialogs.
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!open) setSubmitted(false); }, [open]);

  const errors = validateRole(form);
  const show = (field) => (submitted ? errors[field] : undefined);

  function handleSave() {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    onSave();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      hideScroll
      staticBackdrop
      title={editing ? (readOnly ? `${editing.name} (system role)` : `Edit role`) : "Create role"}
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            {/* `action` (console blue) — the same confirm button as every other
                console dialog. This used to be `success`/`primary`, so creating a
                role was teal and saving one was the theme-inverting black chip. */}
            <Button variant="action" disabled={saving} onClick={handleSave}>
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
          required={!readOnly}
          value={form.name}
          disabled={readOnly}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="Enter role name (e.g. Operator)"
          error={show("name")}
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
