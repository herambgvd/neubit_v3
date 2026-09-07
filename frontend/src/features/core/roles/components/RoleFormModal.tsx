"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

import { Button, Input, Modal } from "@/components/ui/kit";
import type { PermissionEntry, PermissionGroups, RoleOut } from "../../types";
import PermissionSelector from "./PermissionSelector";
import { validateRole, type RoleForm, type RoleFormErrors } from "../validation";

export interface RoleFormModalProps {
  open: boolean;
  onClose: () => void;
  /** null = create. */
  editing: RoleOut | null;
  /** System roles open view-only. */
  readOnly: boolean;
  form: RoleForm;
  setForm: (form: RoleForm) => void;
  groups: PermissionGroups;
  selected: Set<string>;
  catalogLoading: boolean;
  onToggleKey: (key: string) => void;
  onToggleGroup: (perms: PermissionEntry[], checkAll: boolean) => void;
  onSave: () => void;
  saving: boolean;
}

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
}: RoleFormModalProps) {
  // Same submit-then-validate flow as the Add/Edit user dialogs.
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!open) setSubmitted(false); }, [open]);

  const errors = validateRole(form);
  const show = (field: keyof RoleFormErrors) => (submitted ? errors[field] : undefined);

  function handleSave() {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    onSave();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
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
