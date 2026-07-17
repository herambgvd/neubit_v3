"use client";

// Webhook create / edit inline form, sectioned like v2 so the long form stays
// scannable (Basics / Authentication / Payload / Device match / Routing).
//
//   payload_schema     = JSON Schema object — the receiver rejects with 422 when
//                        an incoming payload does not match.
//   transform          = { outKey: JMESPath } — built via the guided
//                        PayloadFieldsBuilder or edited as raw JSON text.
//                        `cap.`-prefixed keys publish as NESTED JSON; every other
//                        key stays a flat literal (see backend transform.py).
//   device_lookup_expr = JMESPath naming the value that identifies the sending
//                        device. v3 has no device registry yet, so the value ships
//                        with the event for a downstream consumer to resolve.
//   slug               = the operator-chosen last segment of the public URL
//                        (/ingest/hooks/{slug}). Set once at create — an
//                        integrator has the URL after that, so editing it would
//                        silently break them; the backend rejects the attempt.
//   auth_type          = none | api_key | basic | bearer | hmac, with the per-type
//                        secret field(s) submitted in the body.
//   request_method     = post (JSON body) | get (query-param payloads).
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, Toggle } from "@/components/ui/kit";
import { Field } from "@/components/common";
import { apiError } from "@/lib/api";
import { ingest as ingestApi } from "../api";
import { AUTH_TYPES, REQUEST_METHODS } from "../constants";
import PayloadFieldsBuilder, {
  fieldsToBackendShape,
  backendShapeToFields,
} from "./PayloadFieldsBuilder";

// A create-time schema that accepts any non-empty object: strict enough to reject
// an empty ping, loose enough not to block a webhook nobody has sampled yet.
const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "minProperties": 1\n}';

// Mirrors _SLUG_RE in the backend schemas — keep the two in step.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
const SLUG_ERROR = "Slug must be 3-64 chars, lowercase a-z, 0-9, underscore, dash";

function Section({ title, hint, open, onToggle, children }) {
  return (
    <div className="rounded-lg border border-card-border bg-card">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
      >
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</span>
          {hint && <p className="mt-0.5 text-[11px] font-normal normal-case tracking-normal text-muted">{hint}</p>}
        </div>
        <Icon
          icon="heroicons-mini:chevron-down"
          className={`shrink-0 text-base text-muted transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && <div className="space-y-3 border-t border-card-border px-3 py-3">{children}</div>}
    </div>
  );
}

export default function WebhookForm({ categoryId, webhook, onCancel, onSaved }) {
  const isEdit = !!webhook;

  const [name, setName] = useState(webhook?.name || "");
  const [slug, setSlug] = useState(webhook?.slug || "");
  const [description, setDescription] = useState(webhook?.description || "");
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
    webhook?.transform && Object.keys(webhook.transform).length
      ? JSON.stringify(webhook.transform, null, 2)
      : "",
  );
  const [schema, setSchema] = useState(
    webhook?.payload_schema && Object.keys(webhook.payload_schema).length
      ? JSON.stringify(webhook.payload_schema, null, 2)
      : isEdit
        ? ""
        : DEFAULT_SCHEMA,
  );
  const [deviceLookupExpr, setDeviceLookupExpr] = useState(webhook?.device_lookup_expr || "");
  const [eventType, setEventType] = useState(webhook?.event_type || "ingest.event");
  const [isActive, setIsActive] = useState(webhook?.is_active !== false);
  const [errors, setErrors] = useState({});

  const [open, setOpen] = useState({
    basics: true,
    auth: true,
    payload: true,
    device: false,
    routing: false,
  });
  const toggle = (k) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  // Guided builder — v2 parity. Its output feeds the same `transform` /
  // `payload_schema` / `device_lookup_expr` the raw editors write, so the two
  // modes stay one source of truth.
  const [builderMode, setBuilderMode] = useState(false);
  const [sampleText, setSampleText] = useState("");
  const [builderFields, setBuilderFields] = useState(
    () => backendShapeToFields(webhook).fields,
  );

  function applyBuilderFields(nextFields) {
    setBuilderFields(nextFields);
    const shape = fieldsToBackendShape(nextFields, deviceLookupExpr);
    setTransform(JSON.stringify(shape.transform, null, 2));
    setSchema(
      Object.keys(shape.payload_schema).length
        ? JSON.stringify(shape.payload_schema, null, 2)
        : "",
    );
    setErrors((p) => ({ ...p, transform: undefined, schema: undefined }));
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
    api_key: { label: "API key", hint: "Sent as Authorization: Bearer <key> or X-API-Key." },
    bearer: { label: "Bearer token", hint: "Sent as Authorization: Bearer <token>." },
    hmac: {
      label: "Signing secret",
      hint: "The sender must send X-Hub-Signature-256: sha256=<hmac> computed over the raw body with this secret.",
    },
    basic: { label: "Password", hint: "Password for HTTP Basic auth." },
  };
  const needsUsername = authType === "basic";
  const needsSecret = authType !== "none";
  const secretCfg = secretMeta[authType];

  function submit(e) {
    e.preventDefault();
    const next = {};
    if (!name.trim()) next.name = "Name is required";

    // Slug is create-only — on edit the field is locked and never submitted.
    if (!isEdit) {
      if (!slug.trim()) next.slug = "Slug is required";
      else if (!SLUG_RE.test(slug.trim())) next.slug = SLUG_ERROR;
    }

    if (needsUsername && !authUsername.trim()) next.authUsername = "Username is required";
    // On edit a blank secret means "keep the stored one" — but only if one exists.
    if (needsSecret && !authSecret && (!isEdit || !webhook?.has_secret)) {
      next.authSecret = "A secret is required for this auth type";
    }
    // The stored secret is encoded per type (hmac reversibly, the rest hashed),
    // so it can't be reinterpreted under a new type. The backend rejects this too
    // — catching it here saves a round trip and names the field.
    if (
      isEdit &&
      needsSecret &&
      !authSecret &&
      authType !== webhook?.auth_type &&
      [authType, webhook?.auth_type].includes("hmac")
    ) {
      next.authSecret = "Changing to or from HMAC requires a new secret";
    }

    let parsedSchema = {};
    if (schema.trim()) {
      try {
        parsedSchema = JSON.parse(schema);
        if (typeof parsedSchema !== "object" || Array.isArray(parsedSchema)) {
          next.schema = "Accepted payload must be a JSON object";
        }
      } catch {
        next.schema = "Accepted payload must be valid JSON";
      }
    }

    let parsedTransform = {};
    if (transform.trim()) {
      try {
        parsedTransform = JSON.parse(transform);
        if (typeof parsedTransform !== "object" || Array.isArray(parsedTransform)) {
          next.transform = "Output map must be a JSON object of { field: expression }";
        } else if (!Object.values(parsedTransform).every((v) => typeof v === "string")) {
          next.transform = "Each output map value must be a JMESPath string";
        }
      } catch {
        next.transform = "Output map must be valid JSON";
      }
    }

    if (Object.keys(next).length) {
      setErrors(next);
      // Open whichever section holds the first error so it isn't hidden.
      setOpen((p) => ({
        ...p,
        basics: p.basics || !!(next.name || next.slug),
        auth: p.auth || !!(next.authUsername || next.authSecret),
        payload: p.payload || !!(next.schema || next.transform),
      }));
      return;
    }

    const body = {
      name: name.trim(),
      description: description.trim() || null,
      request_method: requestMethod,
      auth_type: authType,
      transform: parsedTransform,
      payload_schema: parsedSchema,
      device_lookup_expr: deviceLookupExpr.trim() || null,
      event_type: eventType.trim() || "ingest.event",
      is_active: isActive,
    };
    // Both are create-only: the backend forbids them on update.
    if (!isEdit) {
      body.category_id = categoryId;
      body.slug = slug.trim();
    }

    // Per-type secret(s). Send only what applies; on edit, blank = keep existing.
    if (authType === "basic" && authUsername.trim()) body.auth_username = authUsername.trim();
    if (needsSecret && authSecret) body.auth_secret = authSecret;

    saving.mutate(body);
  }

  return (
    <form noValidate onSubmit={submit} className="rounded-lg border border-card-border bg-hover/40 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">
          {isEdit ? `Edit webhook · ${webhook.slug}` : "Add webhook"}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
        >
          <Icon icon="heroicons-outline:x-mark" className="text-sm" />
        </button>
      </div>

      {/* ── Basics ─────────────────────────────────────────────── */}
      <Section title="Basics" open={open.basics} onToggle={() => toggle("basics")}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Name"
            required
            maxLength={128}
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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field
            label="Slug"
            required
            maxLength={64}
            value={slug}
            disabled={isEdit}
            // Lowercase as they type: the rule allows nothing else, so silently
            // conforming beats bouncing them off a validation error.
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
              if (errors.slug) setErrors((p) => ({ ...p, slug: undefined }));
            }}
            placeholder="face-detection"
            className="font-mono"
            error={errors.slug}
            hint={
              isEdit
                ? "Slug cannot be changed after creation — integrators already use this URL."
                : "URL path segment — lowercase letters, digits, dash, underscore."
            }
          />
          <Field
            label="Inbound path"
            value={`/ingest/hooks/${slug || "{slug}"}`}
            disabled
            className="font-mono"
            hint="The full URL is shown, with a copy button, once the webhook is saved."
          />
        </div>
        <Field
          as="textarea"
          label="Description"
          rows={2}
          maxLength={1024}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What sends to this endpoint? (optional)"
        />
        <div className="flex items-center justify-between rounded-md border border-card-border px-3 py-2">
          <div>
            <p className="text-xs font-medium text-foreground">
              {isActive ? "Enabled" : "Disabled"}
            </p>
            <p className="text-[11px] text-muted">
              When off, the receiver rejects every incoming request.
            </p>
          </div>
          <Toggle checked={isActive} onChange={setIsActive} />
        </div>
      </Section>

      {/* ── Authentication ─────────────────────────────────────── */}
      <Section
        title="Authentication"
        hint="How the sender proves it's allowed to post here."
        open={open.auth}
        onToggle={() => toggle("auth")}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
              maxLength={128}
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
              maxLength={1024}
              type={showSecret ? "text" : "password"}
              value={authSecret}
              onChange={(e) => {
                setAuthSecret(e.target.value);
                if (errors.authSecret) setErrors((p) => ({ ...p, authSecret: undefined }));
              }}
              placeholder={
                isEdit && webhook?.has_secret
                  ? "(unchanged — leave blank to keep)"
                  : `Enter ${secretCfg?.label?.toLowerCase() || "secret"}`
              }
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
        ) : (
          <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-500">
            This endpoint is open — anyone who learns the URL can post to it. Pick an
            auth type before sharing it outside your network.
          </p>
        )}
      </Section>

      {/* ── Payload: schema + output map ───────────────────────── */}
      <Section
        title="Payload"
        hint="What this endpoint accepts, and what it publishes."
        open={open.payload}
        onToggle={() => toggle("payload")}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium uppercase tracking-wide text-muted">
              Output map (field → JMESPath)
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
              showDeviceMatch
              deviceMatchPath={deviceLookupExpr}
              onDeviceMatchPathChange={setDeviceLookupExpr}
            />
          ) : (
            <Field
              as="textarea"
              rows={7}
              value={transform}
              onChange={(e) => {
                setTransform(e.target.value);
                if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
              }}
              placeholder={'{\n  "device_mac": "data.dev_net_info[0].mac",\n  "cap.event_info.description": "data.alarm_list[0].time"\n}'}
              className="font-mono"
              error={errors.transform}
              hint="Leave as an empty object for rule-only extraction. cap.-prefixed keys publish as nested JSON; other keys stay flat."
            />
          )}
        </div>

        <Field
          as="textarea"
          label="Accepted payload (JSON Schema)"
          rows={7}
          value={schema}
          onChange={(e) => {
            setSchema(e.target.value);
            if (errors.schema) setErrors((p) => ({ ...p, schema: undefined }));
          }}
          placeholder='{ "type": "object", "properties": { ... } }'
          className="font-mono"
          error={errors.schema}
          hint="Requests that do not match this schema are rejected with 422. Empty accepts anything."
        />
      </Section>

      {/* ── Device match ───────────────────────────────────────── */}
      <Section
        title="Device match"
        hint="Which value in the payload identifies the sending device."
        open={open.device}
        onToggle={() => toggle("device")}
      >
        <Field
          label="Path in incoming payload"
          maxLength={512}
          value={deviceLookupExpr}
          onChange={(e) => setDeviceLookupExpr(e.target.value)}
          placeholder="data.dev_net_info[0].mac"
          className="font-mono"
          hint="Example: data.dev_net_info[0].mac or device.serial"
        />
        <p className="rounded-md border border-card-border bg-hover/50 px-3 py-2 text-[11px] text-muted">
          The extracted value ships with every published event as
          <code className="mx-1 font-mono">device_lookup_value</code>. Resolving it to a
          device and attaching site / location context is not wired up yet — v3 has no
          device registry.
        </p>
      </Section>

      {/* ── Routing ────────────────────────────────────────────── */}
      <Section
        title="Routing"
        hint="Where matched events go."
        open={open.routing}
        onToggle={() => toggle("routing")}
      >
        <Field
          label="Default event type"
          maxLength={128}
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          placeholder="ingest.event"
          className="font-mono"
          hint="Used only when the webhook has no event rules. With rules, each rule emits its own type."
        />
      </Section>

      <p className="text-[11px] text-muted">
        After saving, open the webhook to add <b>event rules</b> — they split one
        endpoint's payloads into distinct event types.
      </p>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} className="!px-3 !py-1.5 text-xs">
          Cancel
        </Button>
        <Button type="submit" disabled={saving.isPending} className="!px-3 !py-1.5 text-xs">
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}
