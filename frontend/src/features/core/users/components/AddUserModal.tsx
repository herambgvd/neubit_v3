"use client";

import { useEffect, useState } from "react";

import { Button, Input, Modal, PasswordInput, Select, Toggle } from "@/components/ui/kit";
import SiteScopeField from "./SiteScopeField";
import { PASSWORD_HINT, validateNewUser } from "../validation";

export default function AddUserModal({ open, onClose, form, setForm, roleOptions, sites = [], onCreate, creating }: any) {
  // Errors appear on the first Create attempt, then track the field as it is fixed —
  // so the dialog never opens already shouting at an untouched form.
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { if (!open) setSubmitted(false); }, [open]);

  const errors = validateNewUser(form);
  const show = (field) => (submitted ? errors[field] : undefined);

  function handleCreate() {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    onCreate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      hideScroll
      staticBackdrop
      title="Add user"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="action" disabled={creating} onClick={handleCreate}>
            {creating ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Input
          label="Full name"
          required
          value={form.full_name}
          onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          placeholder="Enter full name"
          error={show("full_name")}
        />
        <Input
          label="Email"
          type="email"
          required
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          placeholder="Enter email address"
          error={show("email")}
        />
        <PasswordInput
          label="Password"
          required
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          placeholder="Enter a password"
          hint={PASSWORD_HINT}
          error={show("password")}
        />
        <Select
          label="Role"
          required
          value={form.role_id}
          options={[{ value: "", label: "Select a role…" }, ...roleOptions]}
          onChange={(e) => setForm({ ...form, role_id: e.target.value })}
          error={show("role_id")}
        />
        <SiteScopeField
          sites={sites}
          value={form.site_ids || []}
          onChange={(ids) => setForm({ ...form, site_ids: ids })}
        />
        <div className="flex items-center justify-between rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-nb-ink">Send invite email</div>
            <div className="text-xs text-nb-faint">
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
