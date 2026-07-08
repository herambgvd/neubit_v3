"use client";

// Create/edit modal for a SOP transition — a faithful 1:1 port of neubit_v2's
// transition-form-modal (identity + linked form + required roles + full
// notification config: type/roles/users/email-subject+body/sms), rethemed to v3
// tokens and wired to the v3 API. Two-column at lg+ so the notification section
// doesn't blow up modal height.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { fieldClass, areaClass, FieldLabel } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { titleize, asItems, idOf } from "@/lib/format";
import { workflow as wfApi } from "../api";

const tid = (t) => idOf(t, "transition_id", "id");
const NOTIFY_TYPES = [
  { value: "none", label: "None" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "both", label: "Both" },
];

// Small titled group (v2's <Section>).
function Section({ title, children }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</div>
      {children}
    </div>
  );
}

const chipCls = (active) =>
  `text-xs rounded-full border px-2.5 py-1 transition ${
    active
      ? "border-blue-500 bg-blue-500/10 text-blue-500"
      : "border-card-border bg-card text-muted hover:bg-hover"
  }`;

export default function TransitionModal({ sopId, states = [], transition, defaults, onClose, onSaved }) {
  const isEdit = !!transition;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [requiresNote, setRequiresNote] = useState(false);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [requiredRoleIds, setRequiredRoleIds] = useState([]);
  const [formId, setFormId] = useState("");
  // Notification config
  const [notifyType, setNotifyType] = useState("none");
  const [notifyRoleIds, setNotifyRoleIds] = useState([]);
  const [notifyUserIds, setNotifyUserIds] = useState([]);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [smsMessage, setSmsMessage] = useState("");
  const [nameErr, setNameErr] = useState("");

  useEffect(() => {
    setName(transition?.label || transition?.name || "");
    setDescription(transition?.description || "");
    setRequiresNote(!!transition?.requires_note);
    setConfirmationRequired(!!transition?.confirmation_required);
    setRequiredRoleIds(transition?.required_role_ids || []);
    setFormId(transition?.form_id || transition?.form_config?.form_id || "");
    const nc = transition?.notification_config || {};
    setNotifyType(nc.type || "none");
    setNotifyRoleIds(nc.role_ids || []);
    setNotifyUserIds(nc.user_ids || []);
    setEmailSubject(nc.email_subject || "");
    setEmailBody(nc.email_body || "");
    setSmsMessage(nc.sms_message || "");
    setNameErr("");
  }, [transition]);

  const formsQ = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 100 }) });
  const forms = asItems(formsQ.data);

  const rolesQ = useQuery({
    queryKey: ["auth-roles-min"],
    queryFn: () => api.get("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = asItems(rolesQ.data);

  const saving = useMutation({
    mutationFn: (body) =>
      isEdit ? wfApi.transitions.update(sopId, tid(transition), body) : wfApi.transitions.create(sopId, body),
    onSuccess: () => { toast.success(isEdit ? "Transition updated" : "Transition created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function buildNotificationConfig() {
    if (notifyType === "none") return null;
    const cfg = { type: notifyType };
    if (notifyRoleIds.length) cfg.role_ids = notifyRoleIds;
    if (notifyUserIds.length) cfg.user_ids = notifyUserIds;
    if (notifyType === "email" || notifyType === "both") {
      if (emailSubject) cfg.email_subject = emailSubject;
      if (emailBody) cfg.email_body = emailBody;
    }
    if (notifyType === "sms" || notifyType === "both") {
      if (smsMessage) cfg.sms_message = smsMessage;
    }
    return cfg;
  }

  function submit(e) {
    e?.preventDefault?.();
    if (!name.trim()) { setNameErr("Name is required"); return; }
    const notification_config = buildNotificationConfig();
    const base = {
      label: name.trim(),
      description: description.trim() || null,
      requires_note: requiresNote,
      confirmation_required: confirmationRequired,
      required_role_ids: requiredRoleIds,
      form_id: formId || null,
      notification_config,
    };
    if (isEdit) {
      saving.mutate(base);
    } else {
      const from = defaults?.from_state_id;
      const to = defaults?.to_state_id;
      if (!from || !to) { toast.error("Pick source and target states first"); return; }
      saving.mutate({ ...base, from_state_id: from, to_state_id: to });
    }
  }

  const toggleId = (id, list, setList) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const stateName = (id) => states.find((s) => idOf(s, "state_id", "id") === id)?.name || id;
  const fromName = isEdit ? stateName(transition.from_state_id) : stateName(defaults?.from_state_id);
  const toName = isEdit ? stateName(transition.to_state_id) : stateName(defaults?.to_state_id);
  const showNotify = notifyType !== "none";

  const roleId = (r) => r.role_id || r.id;
  const roleName = (r) => r.display_name || titleize(r.name) || roleId(r);

  return (
    <Modal
      open
      onClose={saving.isPending ? undefined : onClose}
      title={isEdit ? `Edit transition · ${transition.label || transition.name}` : "Add transition"}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving.isPending}>Cancel</Button>
          <Button variant="success" onClick={submit} disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save" : "Create transition"}
          </Button>
        </>
      }
    >
      <div className="mb-4 text-xs text-muted">{fromName || "?"} → {toName || "?"}</div>

      <form noValidate onSubmit={submit} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left: identity + roles ── */}
          <div className="space-y-6">
            <Section title="Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <FieldLabel required>Name</FieldLabel>
                  <input value={name} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(""); }} placeholder="Acknowledge" className={`${fieldClass} ${nameErr ? "!border-red-500" : ""}`} />
                  {nameErr && <p className="mt-1 text-xs text-red-500">{nameErr}</p>}
                </div>
                <div>
                  <FieldLabel>Linked form (optional)</FieldLabel>
                  <select value={formId} onChange={(e) => setFormId(e.target.value)} className={fieldClass}>
                    <option value="" className="bg-card">No form required</option>
                    {forms.map((f) => (
                      <option key={f.form_id} value={f.form_id} className="bg-card">{f.name}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer md:mt-6">
                  <input type="checkbox" checked={requiresNote} onChange={(e) => setRequiresNote(e.target.checked)} /> Requires note
                </label>
                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer md:mt-6">
                  <input type="checkbox" checked={confirmationRequired} onChange={(e) => setConfirmationRequired(e.target.checked)} /> Confirmation required
                </label>
                <div className="md:col-span-2">
                  <FieldLabel>Description</FieldLabel>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Describe when this transition should be used" className={areaClass} />
                </div>
              </div>
            </Section>

            <Section title="Required roles">
              {roles.length === 0 ? (
                <div className="text-xs text-muted">No roles available.</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {roles.map((r) => (
                    <button key={roleId(r)} type="button" onClick={() => toggleId(roleId(r), requiredRoleIds, setRequiredRoleIds)} className={chipCls(requiredRoleIds.includes(roleId(r)))}>
                      {roleName(r)}
                    </button>
                  ))}
                </div>
              )}
            </Section>
          </div>

          {/* ── Right: notification ── */}
          <div className="space-y-6">
            <Section title="Notification">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <FieldLabel>Type</FieldLabel>
                  <select value={notifyType} onChange={(e) => setNotifyType(e.target.value)} className={fieldClass}>
                    {NOTIFY_TYPES.map((t) => <option key={t.value} value={t.value} className="bg-card">{t.label}</option>)}
                  </select>
                </div>
                <div />
              </div>

              {showNotify && (
                <div className="mt-4 space-y-4">
                  {roles.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Notify roles</div>
                      <div className="flex flex-wrap gap-2">
                        {roles.map((r) => (
                          <button key={roleId(r)} type="button" onClick={() => toggleId(roleId(r), notifyRoleIds, setNotifyRoleIds)} className={chipCls(notifyRoleIds.includes(roleId(r)))}>
                            {roleName(r)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <UserMultiSelect
                    label="Notify users"
                    selectedIds={notifyUserIds}
                    onToggle={(uid) => toggleId(uid, notifyUserIds, setNotifyUserIds)}
                    onClear={() => setNotifyUserIds([])}
                  />

                  {(notifyType === "email" || notifyType === "both") && (
                    <div className="space-y-3">
                      <div>
                        <FieldLabel>Email subject</FieldLabel>
                        <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)} placeholder="[{priority}] {instance_name}" className={fieldClass} />
                      </div>
                      <div>
                        <FieldLabel>Email body template</FieldLabel>
                        <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={4} placeholder="Workflow {instance_name} moved from {from_state} to {to_state}." className={areaClass} />
                      </div>
                      <p className="text-[11px] text-muted">
                        Available placeholders:{" "}
                        {["{instance_name}", "{from_state}", "{to_state}", "{priority}"].map((p) => (
                          <code key={p} className="mr-1 rounded bg-hover px-1">{p}</code>
                        ))}
                      </p>
                    </div>
                  )}

                  {(notifyType === "sms" || notifyType === "both") && (
                    <div>
                      <FieldLabel>SMS message</FieldLabel>
                      <textarea value={smsMessage} onChange={(e) => setSmsMessage(e.target.value)} rows={2} placeholder="{instance_name}: {from_state} → {to_state}" className={areaClass} />
                    </div>
                  )}
                </div>
              )}
            </Section>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/* Multi-select user picker with search — selected chips on top + searchable list. */
function UserMultiSelect({ label, selectedIds, onToggle, onClear }) {
  const [query, setQuery] = useState("");
  const usersQ = useQuery({
    queryKey: ["auth-users-picker"],
    queryFn: () => api.get("/auth/users", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const allUsers = asItems(usersQ.data);

  const uid = (u) => u.user_id || u.id;
  const display = (u) =>
    u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || uid(u);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allUsers;
    return allUsers.filter((u) =>
      `${u.email || ""} ${display(u)}`.toLowerCase().includes(q),
    );
  }, [allUsers, query]);
  const selectedUsers = useMemo(() => allUsers.filter((u) => selectedIds.includes(uid(u))), [allUsers, selectedIds]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</div>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <Icon icon="heroicons-outline:users" className="text-sm" />
          {selectedIds.length} selected
          {selectedIds.length > 0 && (
            <button type="button" onClick={onClear} className="hover:text-foreground hover:underline">clear</button>
          )}
        </div>
      </div>

      {selectedUsers.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedUsers.map((u) => (
            <span key={uid(u)} className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-1 text-xs text-blue-500">
              {display(u)}
              <button type="button" onClick={() => onToggle(uid(u))} aria-label={`Remove ${display(u)}`}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-card-border bg-card">
        <label className="relative block border-b border-card-border">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users by name or email…" className="h-9 w-full bg-transparent pl-7 pr-3 text-xs text-foreground outline-none" />
        </label>
        <div className="max-h-40 overflow-y-auto">
          {usersQ.isLoading ? (
            <div className="px-3 py-3 text-xs text-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">No users match &quot;{query}&quot;.</div>
          ) : (
            <ul className="divide-y divide-card-border">
              {filtered.map((u) => {
                const checked = selectedIds.includes(uid(u));
                return (
                  <li key={uid(u)}>
                    <label className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${checked ? "bg-blue-500/10" : "hover:bg-hover"}`}>
                      <input type="checkbox" checked={checked} onChange={() => onToggle(uid(u))} />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-foreground truncate">{display(u)}</span>
                        {u.email && display(u) !== u.email && (
                          <span className="block text-[10px] text-muted truncate">{u.email}</span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
