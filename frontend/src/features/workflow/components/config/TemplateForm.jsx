"use client";

// Create/edit form for a notification template. Name/channel/subject use the
// shared Field; the body is a bespoke monospace textarea with clickable
// {{variable}} insert chips.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { titleize } from "@/lib/format";
import { workflow as wfApi } from "../../api";

// Notification channels a template can target (mirrors backend channel_type).
const CHANNEL_TYPES = ["email", "webhook", "sms", "whatsapp", "mobile_push"];
const TEMPLATE_VARS = ["instance_name", "sop_name", "from_state", "to_state", "priority", "site_id", "event_type"];

export default function TemplateForm({ template, onCancel, onSaved }) {
  const isEdit = !!template;
  const [name, setName] = useState(template?.name || "");
  const [channelType, setChannelType] = useState(template?.channel_type || "email");
  const [subject, setSubject] = useState(template?.subject || "");
  const [body, setBody] = useState(template?.body || "");
  const [isActive, setIsActive] = useState(template?.is_active !== false);
  const [errors, setErrors] = useState({});
  const showSubject = channelType === "email";

  const saving = useMutation({
    mutationFn: (payload) => (isEdit ? wfApi.notifications.templates.update(template.template_id, payload) : wfApi.notifications.templates.create(payload)),
    onSuccess: () => { toast.success(isEdit ? "Template updated" : "Template created"); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    if (!body.trim()) next.body = "Body is required";
    if (Object.keys(next).length) { setErrors(next); return; }
    saving.mutate({
      name: name.trim(),
      channel_type: channelType,
      subject: showSubject ? (subject.trim() || null) : null,
      body: body,
      is_active: isActive,
    });
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit ${template.name}` : "New template"}</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); if (errors.name) setErrors((p) => ({ ...p, name: undefined })); }}
          placeholder="e.g. Fire escalation email"
          error={errors.name}
        />
        <Field
          as="select"
          label="Channel"
          value={channelType}
          onChange={(e) => setChannelType(e.target.value)}
          options={CHANNEL_TYPES.map((c) => ({ value: c, label: titleize(c) }))}
        />
      </div>
      {showSubject && (
        <Field
          label="Subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="e.g. [{{priority}}] {{instance_name}}"
        />
      )}
      <div>
        <label className="text-xs font-medium uppercase tracking-wide text-muted">Body <span className="text-red-500 ml-1">*</span></label>
        <textarea rows={5} value={body} onChange={(e) => { setBody(e.target.value); if (errors.body) setErrors((p) => ({ ...p, body: undefined })); }} className={`mt-1 w-full rounded-lg border border-field bg-transparent px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted outline-none focus:border-muted ${errors.body ? "!border-red-500" : ""}`} placeholder="Incident {{instance_name}} moved {{from_state}} → {{to_state}}." />
        {errors.body && <p className="mt-1 text-xs text-red-500">{errors.body}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="text-[11px] text-muted">Variables:</span>
          {TEMPLATE_VARS.map((v) => (
            <button key={v} type="button" onClick={() => setBody((b) => `${b}{{${v}}}`)} className="text-[11px] font-mono rounded bg-card border border-card-border px-1.5 py-0.5 text-muted hover:text-foreground hover:bg-hover">{`{{${v}}}`}</button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> Active</label>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">{saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create template"}</Button>
      </div>
    </form>
  );
}
