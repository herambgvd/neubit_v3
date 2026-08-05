"use client";

import { Button, Input, Modal, Select, Toggle } from "@/components/ui/kit";
import SiteScopeField from "./SiteScopeField";

// Edit a user through a modal (the Users console mirrors Roles: the centre pane is
// read-only, the pencil opens this form). Role and the Active switch are locked for
// your own account and for Administrator accounts — the same guards the detail
// pane's status segment applies, so the console can never lock itself out.
export default function EditUserModal({
  editing,
  isSelf,
  onClose,
  form,
  setForm,
  roleOptions,
  sites = [],
  onSave,
  saving,
}) {
  const isAdminAccount = !!editing?.role?.is_system;
  const statusLocked = isSelf || isAdminAccount;
  return (
    <Modal
      open={!!editing}
      onClose={onClose}
      hideScroll
      staticBackdrop
      title={`Edit ${editing?.email || "user"}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={saving || !form.role_id} onClick={onSave}>
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
          placeholder="Enter full name"
        />
        <Select
          label="Role"
          required
          value={form.role_id}
          options={roleOptions}
          disabled={isSelf}
          onChange={(e) => setForm({ ...form, role_id: e.target.value })}
        />
        {isSelf && (
          <p className="-mt-2 text-[11px] text-nb-faint">
            You cannot change your own role.
          </p>
        )}
        <SiteScopeField
          sites={sites}
          value={form.site_ids || []}
          onChange={(ids) => setForm({ ...form, site_ids: ids })}
        />
        <div
          className={`flex items-center justify-between rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5 ${
            statusLocked ? "opacity-60" : ""
          }`}
        >
          <div>
            <div className="text-sm font-medium text-nb-ink">Active</div>
            <div className="text-xs text-nb-faint">
              {isSelf
                ? "You cannot disable your own account."
                : isAdminAccount
                  ? "Administrator accounts cannot be disabled."
                  : "Disabled users cannot sign in."}
            </div>
          </div>
          <Toggle
            checked={form.is_active}
            onChange={(v) => !statusLocked && setForm({ ...form, is_active: v })}
          />
        </div>
      </div>
    </Modal>
  );
}
