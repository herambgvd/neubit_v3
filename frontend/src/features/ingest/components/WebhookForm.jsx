"use client";

// Webhook create / edit inline form.
//   transform       = JSON dict of { outKey: JMESPath } — built via the guided
//                     PayloadFieldsBuilder or edited as raw JSON text.
//   payload_schema  = JSON Schema object (raw JSON text).
//   auth_type       = none | api_key | basic | bearer | hmac, with the per-type
//                     secret field(s) submitted in the body.
//   request_method  = post (JSON body) | get (query-param payloads).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { AUTH_TYPES, REQUEST_METHODS } from "../constants";
import PayloadFieldsBuilder, {
  fieldsToTransform,
  transformToFields,
} from "./PayloadFieldsBuilder";

export default function WebhookForm({ categoryId, webhook, onCancel, onSaved }) {
  const isEdit = !!webhook;
  const [name, setName] = useState(webhook?.name || "");
  const [requestMethod, setRequestMethod] = useState(
    (webhook?.request_method || "post").toLowerCase(),
  );
  const [authType, setAuthType] = useState(webhook?.auth_type || "none");

  // Per-type auth secret(s). Never pre-filled on edit (backend never echoes the
  // secret); leaving them blank on edit keeps the existing secret.
  const [authUsername, setAuthUsername] = useState(webhook?.auth_username || "");
  const [authSecret, setAuthSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

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

  // Guided transform builder — v2 parity. Its output feeds the same `transform`
  // JSON as the raw editor, so both modes stay in sync.
  const [builderMode, setBuilderMode] = useState(false);
  const [sampleText, setSampleText] = useState("");
  const [builderFields, setBuilderFields] = useState(() =>
    transformToFields(webhook?.transform),
  );

  function applyBuilderFields(nextFields) {
    setBuilderFields(nextFields);
    setTransform(JSON.stringify(fieldsToTransform(nextFields), null, 2));
    if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
  }

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

  // Per-auth-type secret metadata: label + hint for the secret input.
  const secretMeta = {
    api_key: { label: "API key", hint: "Sent by the caller as the API key." },
    bearer: { label: "Bearer token", hint: "Sent as Authorization: Bearer <token>." },
    hmac: {
      label: "Signing secret",
      hint: "The sender must send X-Hub-Signature-256: sha256=<hmac> computed over the raw body with this secret.",
    },
    basic: { label: "Password", hint: "Password for HTTP Basic auth." },
  };
  const needsUsername = authType === "basic";
  const needsSecret = authType !== "none";

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";

    if (needsUsername && !authUsername.trim()) next.authUsername = "Username is required";
    if (needsSecret && !isEdit && !authSecret) {
      next.authSecret = "A secret is required for this auth type";
    }

    // Both are JSON objects on the backend (payload_schema: dict, transform: {key: JMESPath}).
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
      request_method: requestMethod,
      auth_type: authType,
      transform: parsedTransform,
      payload_schema: parsedSchema,
      is_active: isActive,
    };
    if (!isEdit) body.category_id = categoryId;

    // Per-type secret(s). Send only what applies; on edit, blank = keep existing.
    if (authType === "basic") {
      if (authUsername.trim()) body.auth_username = authUsername.trim();
      if (authSecret) body.auth_secret = authSecret;
    } else if (needsSecret) {
      if (authSecret) body.auth_secret = authSecret;
    }

    saving.mutate(body);
  }

  const secretCfg = secretMeta[authType];

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
          label="Request method"
          value={requestMethod}
          onChange={(e) => setRequestMethod(e.target.value)}
          options={REQUEST_METHODS}
          hint="POST reads a JSON body. GET reads query params as the payload."
        />
      </div>

      {/* ── Authentication ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          as="select"
          label="Auth type"
          value={authType}
          onChange={(e) => {
            setAuthType(e.target.value);
            setErrors((p) => ({ ...p, authUsername: undefined, authSecret: undefined }));
          }}
          options={AUTH_TYPES}
        />
        {needsUsername ? (
          <Field
            label="Username"
            required
            value={authUsername}
            onChange={(e) => {
              setAuthUsername(e.target.value);
              if (errors.authUsername) setErrors((p) => ({ ...p, authUsername: undefined }));
            }}
            placeholder="Enter auth username"
            autoComplete="off"
            error={errors.authUsername}
          />
        ) : null}
      </div>

      {needsSecret ? (
        <div className="relative">
          <Field
            label={secretCfg?.label || "Secret"}
            required={!isEdit}
            type={showSecret ? "text" : "password"}
            value={authSecret}
            onChange={(e) => {
              setAuthSecret(e.target.value);
              if (errors.authSecret) setErrors((p) => ({ ...p, authSecret: undefined }));
            }}
            placeholder={isEdit ? "Leave blank to keep the existing secret" : `Enter ${secretCfg?.label?.toLowerCase() || "secret"}`}
            autoComplete="new-password"
            className="pr-10"
            error={errors.authSecret}
            hint={secretCfg?.hint}
          />
          <button
            type="button"
            aria-label={showSecret ? "Hide secret" : "Show secret"}
            onClick={() => setShowSecret((v) => !v)}
            className="absolute right-3 top-[30px] text-muted hover:text-foreground"
          >
            <Icon icon={showSecret ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="text-base" />
          </button>
        </div>
      ) : null}

      {/* ── Transform (field map) ──────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium uppercase tracking-wide text-muted">
            Transform (field map)
          </label>
          <div className="inline-flex rounded-md border border-card-border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setBuilderMode(false)}
              className={`rounded px-2 py-0.5 transition ${!builderMode ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}
            >
              Raw JSON
            </button>
            <button
              type="button"
              onClick={() => setBuilderMode(true)}
              className={`rounded px-2 py-0.5 transition ${builderMode ? "bg-foreground text-background" : "text-muted hover:text-foreground"}`}
            >
              Guided
            </button>
          </div>
        </div>

        {builderMode ? (
          <PayloadFieldsBuilder
            sampleText={sampleText}
            onSampleTextChange={setSampleText}
            fields={builderFields}
            onFieldsChange={applyBuilderFields}
          />
        ) : (
          <Field
            as="textarea"
            rows={4}
            value={transform}
            onChange={(e) => {
              setTransform(e.target.value);
              if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
            }}
            placeholder={'{\n  "title": "event.name",\n  "priority": "event.severity"\n}'}
            className="font-mono"
            error={errors.transform}
            hint="JSON object mapping each output field to a JMESPath expression over the incoming payload."
          />
        )}
      </div>

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
