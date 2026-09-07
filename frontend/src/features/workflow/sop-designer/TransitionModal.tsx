"use client";

// Create/edit modal for a SOP transition — a faithful 1:1 port of neubit_v2's
// transition-form-modal (identity + linked form + required roles + full
// notification config: type/roles/users/email-subject+body/sms), rethemed to v3
// tokens and wired to the v3 API. Two-column at lg+ so the notification section
// doesn't blow up modal height.
import { useEffect, useMemo, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction, SyntheticEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Modal } from "@/components/ui/kit";
import { fieldClass, areaClass, FieldLabel } from "@/components/common";
import { api, apiError } from "@/lib/api";
import type { Page } from "@/lib/types";
import { titleize, asItems } from "@/lib/format";
import { workflow as wfApi } from "../api";
import type {
  AssignableRole,
  AssignableUser,
  CreateTransitionRequest,
  FormPublic,
  StatePublic,
  TransitionNotificationConfig,
  TransitionPublic,
  UpdateTransitionRequest,
} from "../types";

type NotifyType = TransitionNotificationConfig["type"];

const NOTIFY_TYPES: { value: NotifyType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "both", label: "Both" },
];
const isNotifyType = (v: string): v is NotifyType => NOTIFY_TYPES.some((t) => t.value === v);

// Small titled group (v2's <Section>).
function Section({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{title}</div>
      {children}
    </div>
  );
}

const chipCls = (active: boolean): string =>
  `text-xs rounded-full border px-2.5 py-1 transition ${
    active
      ? "border-nb-blue bg-[rgba(96,165,250,.10)] text-nb-blueb"
      : "border-nb-line bg-[rgba(8,15,34,.5)] text-nb-muted hover:bg-[rgba(96,165,250,.1)]"
  }`;

/** Edit sends a PATCH body; create needs the endpoints too. */
type SaveVars =
  | { id: string; body: UpdateTransitionRequest }
  | { id: null; body: CreateTransitionRequest };

export interface TransitionModalProps {
  sopId: string;
  states?: StatePublic[];
  /** The transition being edited; null creates one between `defaults`. */
  transition: TransitionPublic | null;
  defaults?: { from_state_id?: string; to_state_id?: string } | null;
  onClose: () => void;
  onSaved: () => void;
}

// Pure, and therefore module scope. Declared in the component body these were a new
// function every render: a memo listing one honestly would rebuild every time, and the
// memo that omitted it was leaning on the omission being harmless. Stable here, so the
// dependency can simply be declared.
const uid = (u: AssignableUser): string => u.id;
const display = (u: AssignableUser): string => u.full_name || u.email || uid(u);

export default function TransitionModal({ sopId, states = [], transition, defaults, onClose, onSaved }: TransitionModalProps) {
  const isEdit = !!transition;

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [requiresNote, setRequiresNote] = useState(false);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [requiredRoleIds, setRequiredRoleIds] = useState<string[]>([]);
  const [formId, setFormId] = useState("");
  // Notification config
  const [notifyType, setNotifyType] = useState<NotifyType>("none");
  const [notifyRoleIds, setNotifyRoleIds] = useState<string[]>([]);
  const [notifyUserIds, setNotifyUserIds] = useState<string[]>([]);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [smsMessage, setSmsMessage] = useState("");
  const [nameErr, setNameErr] = useState("");

  useEffect(() => {
    setName(transition?.label || "");
    setDescription(transition?.description || "");
    setRequiresNote(!!transition?.requires_note);
    setConfirmationRequired(!!transition?.confirmation_required);
    setRequiredRoleIds(transition?.required_role_ids || []);
    setFormId(transition?.form_id || "");
    const nc: Partial<TransitionNotificationConfig> = transition?.notification_config || {};
    setNotifyType(nc.type || "none");
    setNotifyRoleIds(nc.role_ids || []);
    setNotifyUserIds(nc.user_ids || []);
    setEmailSubject(nc.email_subject || "");
    setEmailBody(nc.email_body || "");
    setSmsMessage(nc.sms_message || "");
    setNameErr("");
  }, [transition]);

  const formsQ = useQuery({ queryKey: ["wf-forms"], queryFn: () => wfApi.forms.list({ limit: 100 }) });
  const forms = useMemo<FormPublic[]>(() => (formsQ.data ? asItems(formsQ.data) : []), [formsQ.data]);

  const rolesQ = useQuery({
    queryKey: ["auth-roles-min"],
    queryFn: () => api.get<Page<AssignableRole>>("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = useMemo<AssignableRole[]>(() => (rolesQ.data ? asItems(rolesQ.data) : []), [rolesQ.data]);

  const saving = useMutation({
    mutationFn: (v: SaveVars) =>
      v.id === null ? wfApi.transitions.create(sopId, v.body) : wfApi.transitions.update(sopId, v.id, v.body),
    onSuccess: () => { toast.success(isEdit ? "Transition updated" : "Transition created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function buildNotificationConfig(): TransitionNotificationConfig | null {
    if (notifyType === "none") return null;
    const cfg: TransitionNotificationConfig = { type: notifyType };
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

  // Reached from the footer button (a click) and the form (a submit).
  function submit(e?: SyntheticEvent) {
    e?.preventDefault?.();
    if (!name.trim()) { setNameErr("Name is required"); return; }
    const notification_config = buildNotificationConfig();
    const base: UpdateTransitionRequest = {
      label: name.trim(),
      description: description.trim() || null,
      requires_note: requiresNote,
      confirmation_required: confirmationRequired,
      required_role_ids: requiredRoleIds,
      form_id: formId || null,
      notification_config,
    };
    if (transition) {
      saving.mutate({ id: transition.transition_id, body: base });
    } else {
      const from = defaults?.from_state_id;
      const to = defaults?.to_state_id;
      if (!from || !to) { toast.error("Pick source and target states first"); return; }
      saving.mutate({ id: null, body: { ...base, label: name.trim(), from_state_id: from, to_state_id: to } });
    }
  }

  const toggleId = (id: string, list: string[], setList: Dispatch<SetStateAction<string[]>>) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const stateName = (id: string | undefined): string | undefined => states.find((s) => s.state_id === id)?.name || id;
  const fromName = transition ? stateName(transition.from_state_id) : stateName(defaults?.from_state_id);
  const toName = transition ? stateName(transition.to_state_id) : stateName(defaults?.to_state_id);
  const showNotify = notifyType !== "none";

  const roleId = (r: AssignableRole): string => r.id;
  const roleName = (r: AssignableRole): string => titleize(r.name) || roleId(r);

  return (
    <Modal
      open
      onClose={saving.isPending ? undefined : onClose}
      title={transition ? `Edit transition · ${transition.label}` : "Add transition"}
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
      <div className="mb-4 text-xs text-nb-muted">{fromName || "?"} → {toName || "?"}</div>

      <form noValidate onSubmit={submit} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* ── Left: identity + roles ── */}
          <div className="space-y-6">
            <Section title="Identity">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <FieldLabel required>Name</FieldLabel>
                  <input value={name} onChange={(e) => { setName(e.target.value); if (nameErr) setNameErr(""); }} placeholder="Acknowledge" className={`${fieldClass} ${nameErr ? "!border-nb-crit" : ""}`} />
                  {nameErr && <p className="mt-1 text-xs text-nb-crit">{nameErr}</p>}
                </div>
                <div>
                  <FieldLabel>Linked form (optional)</FieldLabel>
                  <select value={formId} onChange={(e) => setFormId(e.target.value)} className={fieldClass}>
                    <option value="" className="bg-[rgba(8,15,34,.5)]">No form required</option>
                    {forms.map((f) => (
                      <option key={f.form_id} value={f.form_id} className="bg-[rgba(8,15,34,.5)]">{f.name}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-nb-ink cursor-pointer md:mt-6">
                  <input type="checkbox" checked={requiresNote} onChange={(e) => setRequiresNote(e.target.checked)} /> Requires note
                </label>
                <label className="flex items-center gap-2 text-sm text-nb-ink cursor-pointer md:mt-6">
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
                <div className="text-xs text-nb-muted">No roles available.</div>
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
                  <select value={notifyType} onChange={(e) => { if (isNotifyType(e.target.value)) setNotifyType(e.target.value); }} className={fieldClass}>
                    {NOTIFY_TYPES.map((t) => <option key={t.value} value={t.value} className="bg-[rgba(8,15,34,.5)]">{t.label}</option>)}
                  </select>
                </div>
                <div />
              </div>

              {showNotify && (
                <div className="mt-4 space-y-4">
                  {roles.length > 0 && (
                    <div>
                      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-nb-muted">Notify roles</div>
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
                      <p className="text-[11px] text-nb-muted">
                        Available placeholders:{" "}
                        {["{instance_name}", "{from_state}", "{to_state}", "{priority}"].map((p) => (
                          <code key={p} className="mr-1 rounded-sm bg-[rgba(96,165,250,.1)] px-1">{p}</code>
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

interface UserMultiSelectProps {
  label: ReactNode;
  selectedIds: string[];
  onToggle: (userId: string) => void;
  onClear: () => void;
}

/* Multi-select user picker with search — selected chips on top + searchable list. */
function UserMultiSelect({ label, selectedIds, onToggle, onClear }: UserMultiSelectProps) {
  const [query, setQuery] = useState("");
  const usersQ = useQuery({
    queryKey: ["auth-users-picker"],
    queryFn: () => api.get<Page<AssignableUser>>("/auth/users", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const allUsers = useMemo<AssignableUser[]>(() => (usersQ.data ? asItems(usersQ.data) : []), [usersQ.data]);


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
        <div className="text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{label}</div>
        <div className="flex items-center gap-2 text-[11px] text-nb-muted">
          <Icon icon="heroicons-outline:users" className="text-sm" />
          {selectedIds.length} selected
          {selectedIds.length > 0 && (
            <button type="button" onClick={onClear} className="hover:text-nb-ink hover:underline">clear</button>
          )}
        </div>
      </div>

      {selectedUsers.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedUsers.map((u) => (
            <span key={uid(u)} className="inline-flex items-center gap-1 rounded-full border border-[rgba(96,165,250,.30)] bg-[rgba(96,165,250,.10)] px-2.5 py-1 text-xs text-nb-blueb">
              {display(u)}
              <button type="button" onClick={() => onToggle(uid(u))} aria-label={`Remove ${display(u)}`}>×</button>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-nb-line bg-[rgba(8,15,34,.5)]">
        <label className="relative block border-b border-nb-line">
          <Icon icon="heroicons-outline:magnifying-glass" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-nb-muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users by name or email…" className="h-9 w-full bg-transparent pl-7 pr-3 text-xs text-nb-ink outline-hidden" />
        </label>
        <div className="max-h-40 overflow-y-auto">
          {usersQ.isLoading ? (
            <div className="px-3 py-3 text-xs text-nb-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-nb-muted">No users match &quot;{query}&quot;.</div>
          ) : (
            <ul className="divide-y divide-card-border">
              {filtered.map((u) => {
                const checked = selectedIds.includes(uid(u));
                return (
                  <li key={uid(u)}>
                    <label className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs ${checked ? "bg-[rgba(96,165,250,.10)]" : "hover:bg-[rgba(96,165,250,.1)]"}`}>
                      <input type="checkbox" checked={checked} onChange={() => onToggle(uid(u))} />
                      <span className="flex-1 min-w-0">
                        <span className="block font-medium text-nb-ink truncate">{display(u)}</span>
                        {u.email && display(u) !== u.email && (
                          <span className="block text-[10px] text-nb-muted truncate">{u.email}</span>
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
