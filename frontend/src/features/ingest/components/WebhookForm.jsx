"use client";

// Webhook create / edit inline form. transform = JSON dict of { field: JMESPath },
// payload_schema = JSON Schema object. Both are edited as JSON text then parsed.
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { AUTH_TYPES } from "../constants";

export default function WebhookForm({ categoryId, webhook, onCancel, onSaved }) {
  const isEdit = !!webhook;
  const [name, setName] = useState(webhook?.name || "");
  const [authType, setAuthType] = useState(webhook?.auth_type || "none");
  const [transform, setTransform] = useState(
    webhook?.transform && Object.keys(webhook.transform).length ? JSON.stringify(webhook.transform, null, 2) : "",
  );
  const [schema, setSchema] = useState(
    webhook?.payload_schema && Object.keys(webhook.payload_schema).length
      ? JSON.stringify(webhook.payload_schema, null, 2)
      : "",
  );
  const [isActive, setIsActive] = useState(webhook?.is_active !== false);
  const [errors, setErrors] = useState({});

  const saving = useMutation({
    mutationFn: (body) => {
      const id = webhook?.id ?? webhook?.webhook_id;
      return isEdit ? ingestApi.webhooks.update(id, body) : ingestApi.webhooks.create(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? "Webhook updated" : "Webhook created");
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";
    // Both fields are JSON objects on the backend (payload_schema: dict, transform: {key: JMESPath}).
    let parsedSchema = {};
    if (schema.trim()) {
      try { parsedSchema = JSON.parse(schema); }
      catch { next.schema = "Schema must be valid JSON"; }
    }
    let parsedTransform = {};
    if (transform.trim()) {
      try { parsedTransform = JSON.parse(transform); }
      catch { next.transform = "Transform must be a valid JSON object"; }
    }
    if (parsedTransform && (typeof parsedTransform !== "object" || Array.isArray(parsedTransform))) {
      next.transform = "Transform must be a JSON object of { field: expression }";
    }
    if (Object.keys(next).length) {
      setErrors(next);
      return;
    }
    const body = {
      name: name.trim(),
      auth_type: authType,
      transform: parsedTransform,
      payload_schema: parsedSchema,
      is_active: isActive,
    };
    if (!isEdit) body.category_id = categoryId;
    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{isEdit ? `Edit webhook · ${webhook.name}` : "Add webhook"}</h4>
        <button type="button" onClick={onCancel} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground">
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
          }}
          placeholder="Enter webhook name"
          error={errors.name}
        />
        <Field
          as="select"
          label="Auth type"
          value={authType}
          onChange={(e) => setAuthType(e.target.value)}
          options={AUTH_TYPES}
        />
      </div>

      <Field
        as="textarea"
        label="Transform (field map)"
        rows={3}
        value={transform}
        onChange={(e) => {
          setTransform(e.target.value);
          if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
        }}
        placeholder={'{\n  "title": "event.name",\n  "priority": "event.severity"\n}'}
        className="font-mono"
        error={errors.transform}
        hint="Optional JSON object mapping each output field to a JMESPath expression over the incoming payload."
      />

      <Field
        as="textarea"
        label="Schema (JSON)"
        rows={5}
        value={schema}
        onChange={(e) => {
          setSchema(e.target.value);
          if (errors.schema) setErrors((p) => ({ ...p, schema: undefined }));
        }}
        placeholder='{ "type": "object", "properties": { ... } }'
        className="font-mono"
        error={errors.schema}
        hint="Optional JSON Schema to validate the transformed payload."
      />

      <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Active
      </label>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">Cancel</Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}
