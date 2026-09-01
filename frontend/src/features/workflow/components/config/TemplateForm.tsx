"use client";

// Create/edit form for a notification template. Name/channel/subject use the
// shared Field; the body is a bespoke monospace textarea with clickable
// {{variable}} insert chips.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button, Checkbox } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";
import { PaneForm } from "@/components/console";

// Notification channels a template can target (mirrors backend channel_type).
const CHANNEL_TYPES = ["email", "webhook", "sms", "whatsapp", "mobile_push"];
const TEMPLATE_VARS = ["instance_name", "sop_name", "from_state", "to_state", "priority", "site_id", "event_type"];

export default function TemplateForm({ template, onCancel, onSaved }: any) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name || "");
  const [channelType, setChannelType] = useState(template?.channel_type || "email");
  const [description, setDescription] = useState(template?.description || "");
  const [subject, setSubject] = useState(template?.subject || "");
  const [body, setBody] = useState(template?.body || "");
  const [providerRef, setProviderRef] = useState(template?.provider_template_ref || "");
  const [isActive, setIsActive] = useState(template?.is_active !== false);
  const [errors, setErrors] = useState<any>({});
  const showSubject = channelType === "email";
  const showProviderRef = channelType === "whatsapp";

  const saving = useMutation<any, any, any>({
    mutationFn: (payload: any) => (isEdit ? wfApi.notifications.templates.update(template.template_id, payload) : wfApi.notifications.templates.create(payload)),
    onSuccess: () => { toast.success(isEdit ? "Template updated" : "Template created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next: any = {};
    if (!name.trim()) next.name = "Name is required";
    if (!body.trim()) next.body = "Body is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    const payload: any = {
      name: name.trim(),
      description: description.trim() || null,
      subject: showSubject ? (subject.trim() || null) : null,
      body: body,
      provider_template_ref: showProviderRef ? (providerRef.trim() || null) : null,
      is_active: isActive,
    };
    if (!isEdit) payload.channel_type = channelType;
    saving.mutate(payload);
  }

  return (
    <PaneForm
      title={isEdit ? `Edit ${template.name}` : "New template"}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={saving.isPending}>
            {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create template"}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }}
          placeholder="e.g. Fire escalation email"
          error={errors.name}
        />
        {isEdit ? (
          <Field label="Channel" value={titleize(channelType)} disabled hint="Can't be changed after create." />
        ) : (
          <Field
            as="select"
            label="Channel"
            value={channelType}
            onChange={(e) => setChannelType(e.target.value)}
            options={CHANNEL_TYPES.map((c) => ({ value: c, label: titleize(c) }))}
          />
        )}
      </div>
      <Field
        as="textarea"
        rows={2}
        label="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={1024}
        placeholder="Optional — what this template is for"
      />
      {showSubject && (
        <Field
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. [{{priority}}] {{instance_name}}"
        />
      )}
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-nb-faint">Body <span className="text-nb-crit ml-1">*</span></label>
        <textarea rows={5} value={body} onChange={(e) => { setBody(e.target.value); if (errors.body) setErrors((p) => ({ ...p, body: undefined })); }} className={`mt-1 w-full rounded-lg border border-nb-line bg-transparent px-3 py-2 text-sm font-mono text-nb-ink placeholder:text-nb-faint outline-hidden focus:border-nb-teal ${errors.body ? "!border-nb-crit" : ""}`} placeholder="Incident {{instance_name}} moved {{from_state}} → {{to_state}}." />
        {errors.body && <p className="mt-1 text-xs text-nb-crit">{errors.body}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="text-[11px] text-nb-faint">Variables:</span>
          {TEMPLATE_VARS.map((v) => (
            <button key={v} type="button" onClick={() => setBody((b) => `${b}{{${v}}}`)} className="text-[11px] font-mono rounded-sm bg-[rgba(8,15,34,.5)] border border-nb-line px-1.5 py-0.5 text-nb-faint hover:text-nb-ink hover:bg-[rgba(96,165,250,.1)]">{`{{${v}}}`}</button>
          ))}
        </div>
      </div>
      {showProviderRef && (
        <Field
          label="Provider template ref"
          value={providerRef}
          onChange={(e) => setProviderRef(e.target.value)}
          placeholder="e.g. alarm_fired_v1"
          className="font-mono"
          hint="Meta/WhatsApp provider-side template id — must match an approved template."
        />
      )}
      <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
    </PaneForm>
  );
}
