"use client";

// Webhook create / edit inline form.
//   transform       = JSON dict of { outKey: JMESPath } — built via the guided
//                     PayloadFieldsBuilder or edited as raw JSON text.
//   payload_schema  = JSON Schema object (raw JSON text).
//   auth_type       = none | api_key | basic | bearer | hmac, with the per-type
//                     secret field(s) submitted in the body.
//   request_method  = post (JSON body) | get (query-param payloads).
import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { trimChars } from "@/lib/validate";

import type { AxiosError } from "axios";

import { Segmented, RowAction } from "@/components/console";
import { Button, Checkbox } from "@/components/ui/kit";
import { Field, FieldLabel } from "@/components/common";
import { apiError } from "@/lib/api";
import type { ApiErrorBody } from "@/lib/types";
import { ingest as ingestApi } from "../api";
import { receiverUrl } from "../lib/receiverUrl";
import { AUTH_TYPES, REQUEST_METHODS } from "../constants";
import PayloadFieldsBuilder, {
  fieldsToTransform,
  transformToFields,
} from "./PayloadFieldsBuilder";
import type { AuthType, BuilderField, InboundMethod, JsonObject, WebhookCreate, WebhookPublic, WebhookUpdate } from "../types";
import type { FieldChangeEvent } from "@/components/common/Field";

// The backend's slug rule, verbatim — `_SLUG_RE` / `_SLUG_ERROR` in
// backend/ingest/app/ingest/schemas.py. Lowercase alphanumeric with -/_, 3-64
// chars, first and last character alphanumeric. Same message, so a client-side
// rejection reads exactly like a server-side one.
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
const SLUG_ERROR = "slug must be lowercase alphanumeric with -/_ (3-64 chars)";

/** Name → a slug that satisfies SLUG_RE: lowercase, non-slug runs collapsed to a
 *  single "-", trimmed to an alphanumeric at both ends, capped at 64. */
function slugify(name: string): string {
  // `[^a-z0-9]+` already collapses runs, so the second replace was a no-op; the
  // leading/trailing strip is a loop because an anchored `-+$` is the shape that
  // backtracks.
  return trimChars(name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-").slice(0, 64);
}

/** The machine code from the uniform error envelope (`{ error: { code } }` —
 *  backend/kernel/kernel/errors.py). ConflictError answers 409 with "CONFLICT",
 *  which is how the slug clash is told apart from any other failure without
 *  matching on message text. */
function errorCode(e: unknown): string | undefined {
  return (e as AxiosError<ApiErrorBody> | undefined)?.response?.data?.error?.code;
}

/** What `mutationFn` is handed: the two wire shapes are genuinely different —
 *  create carries `slug` + `category_id`, update carries neither. */
type SavePayload =
  | { mode: "create"; body: WebhookCreate }
  | { mode: "edit"; id: string; body: WebhookUpdate };

/** The form's per-field validation messages. */
interface WebhookFormErrors {
  name?: string;
  slug?: string;
  authUsername?: string;
  authSecret?: string;
  schema?: string;
  transform?: string;
}

export interface WebhookFormProps {
  /** The category a NEW webhook is created in. */
  categoryId?: string;
  /** Null = create. */
  webhook?: WebhookPublic | null;
  onCancel: () => void;
  onSaved: () => void;
}

export default function WebhookForm({ categoryId, webhook, onCancel, onSaved }: WebhookFormProps) {
  const isEdit = !!webhook;
  const [name, setName] = useState(webhook?.name || "");
  // The slug IS the last segment of the public receiver URL, and it is fixed at
  // create time (WebhookUpdate has no slug field), so on edit it is display-only.
  const [slug, setSlug] = useState(webhook?.slug || "");
  // Suggest a slug from the name until the operator types one themselves — after
  // that their value is never overwritten. On edit there is nothing to suggest.
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [requestMethod, setRequestMethod] = useState<InboundMethod>(
    ((webhook?.request_method || "post").toLowerCase() as InboundMethod),
  );
  const [authType, setAuthType] = useState<AuthType>(webhook?.auth_type || "none");

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
  const [errors, setErrors] = useState<WebhookFormErrors>({});

  // Guided transform builder — v2 parity. Its output feeds the same `transform`
  // JSON as the raw editor, so both modes stay in sync.
  const [builderMode, setBuilderMode] = useState(false);
  const [sampleText, setSampleText] = useState("");
  const [builderFields, setBuilderFields] = useState(() =>
    transformToFields(webhook?.transform),
  );

  function applyBuilderFields(nextFields: BuilderField[]) {
    setBuilderFields(nextFields);
    setTransform(JSON.stringify(fieldsToTransform(nextFields), null, 2));
    if (errors.transform) setErrors((p) => ({ ...p, transform: undefined }));
  }

  const saving = useMutation({
    // `submit` decides which wire shape it built, so neither branch needs a cast.
    mutationFn: (p: SavePayload) =>
      p.mode === "edit"
        ? ingestApi.webhooks.update(p.id, p.body)
        : ingestApi.webhooks.create(p.body),
    onSuccess: () => {
      toast.success(isEdit ? "Webhook updated" : "Webhook created");
      onSaved();
    },
    onError: (e) => {
      // The slug is globally unique across tenants; WebhookService.create raises
      // ConflictError("slug already in use") → 409/CONFLICT. Keep the operator in
      // the form with the clash marked on the field they can actually change.
      if (!isEdit && errorCode(e) === "CONFLICT") {
        setErrors((p) => ({ ...p, slug: "That slug is already taken — choose another." }));
        toast.error("Slug already in use");
        return;
      }
      toast.error(apiError(e));
    },
  });

  // Per-auth-type secret metadata: label + hint for the secret input.
  const secretMeta: Record<string, { label: string; hint: string }> = {
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

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: WebhookFormErrors = {};
    if (!name.trim()) next.name = "Name is required";
    // Create only — the slug is not editable (and not sent) on edit.
    if (!isEdit) {
      const s = slug.trim();
      if (!s) next.slug = "Slug is required";
      else if (!SLUG_RE.test(s)) next.slug = SLUG_ERROR;
    }

    if (needsUsername && !authUsername.trim()) next.authUsername = "Username is required";
    if (needsSecret && !isEdit && !authSecret) {
      next.authSecret = "A secret is required for this auth type";
    }

    // Both are JSON objects on the backend (payload_schema: dict, transform: {key: JMESPath}).
    let parsedSchema: JsonObject = {};
    if (schema.trim()) {
      try { parsedSchema = JSON.parse(schema); }
      catch { next.schema = "Schema must be valid JSON"; }
    }
    let parsedTransform: Record<string, string> = {};
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

    // Fields both wire shapes share. Per-type secret(s): send only what applies;
    // on edit, blank = keep existing.
    const shared = {
      name: name.trim(),
      request_method: requestMethod,
      auth_type: authType,
      transform: parsedTransform,
      payload_schema: parsedSchema,
      is_active: isActive,
      ...(needsUsername && authUsername.trim() ? { auth_username: authUsername.trim() } : {}),
      ...(needsSecret && authSecret ? { auth_secret: authSecret } : {}),
    };

    // The slug goes on create only: WebhookUpdate has no slug and forbids extras,
    // so sending it on edit would 422 (backend/ingest/app/ingest/schemas.py).
    if (isEdit) saving.mutate({ mode: "edit", id: webhook.id, body: shared });
    else saving.mutate({ mode: "create", body: { ...shared, category_id: categoryId ?? "", slug: slug.trim() } });
  }

  const secretCfg = secretMeta[authType];

  return (
    <form noValidate onSubmit={submit} className="space-y-4 rounded-[10px] border border-nb-line bg-[rgba(6,11,26,.5)] p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-[11px] font-semibold uppercase tracking-[1.3px] text-nb-muted">{isEdit ? `Edit webhook · ${webhook.name}` : "Add webhook"}</h4>
<RowAction icon="heroicons-outline:x-mark" title="Close" onClick={onCancel} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          label="Name"
          required
          value={name}
          onChange={(e: FieldChangeEvent) => {
            setName(e.target.value);
            // Suggest until the operator takes over the slug field themselves.
            if (!slugTouched) setSlug(slugify(e.target.value));
            if (errors.name) setErrors((p) => ({ ...p, name: undefined }));
          }}
          placeholder="Enter webhook name"
          error={errors.name}
        />
        <Field
          as="select"
          label="Request method"
          value={requestMethod}
          onChange={(e: FieldChangeEvent) => setRequestMethod(e.target.value as InboundMethod)}
          options={REQUEST_METHODS}
          hint="POST reads a JSON body. GET reads query params as the payload."
        />
      </div>

      {/* ── Slug — the last segment of the public receiver URL ─────────── */}
      <div>
        <Field
          label="Slug"
          required={!isEdit}
          value={slug}
          readOnly={isEdit}
          onChange={(e: FieldChangeEvent) => {
            setSlugTouched(true);
            setSlug(e.target.value);
            if (errors.slug) setErrors((p) => ({ ...p, slug: undefined }));
          }}
          placeholder="acme-door-events"
          autoComplete="off"
          className={`font-mono${isEdit ? " opacity-70" : ""}`}
          error={errors.slug}
          hint={
            isEdit
              ? "Fixed at creation — the integrator already has this URL, so it is not sent on save."
              : SLUG_ERROR
          }
        />
        <p className="mt-1 text-[11px] text-nb-faint">
          Receiver URL:{" "}
          <code className="font-mono text-nb-ink">
            {receiverUrl(slug || "<slug>", isEdit ? webhook.ingest_url : null)}
          </code>
        </p>
      </div>

      {/* ── Authentication ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field
          as="select"
          label="Auth type"
          value={authType}
          onChange={(e: FieldChangeEvent) => {
            setAuthType(e.target.value as AuthType);
            setErrors((p) => ({ ...p, authUsername: undefined, authSecret: undefined }));
          }}
          options={AUTH_TYPES}
        />
        {needsUsername ? (
          <Field
            label="Username"
            required
            value={authUsername}
            onChange={(e: FieldChangeEvent) => {
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
            onChange={(e: FieldChangeEvent) => {
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
            className="absolute right-3 top-[30px] text-nb-faint transition hover:text-nb-ink"
          >
            <Icon icon={showSecret ? "heroicons-outline:eye-slash" : "heroicons-outline:eye"} className="text-base" />
          </button>
        </div>
      ) : null}

      {/* ── Transform (field map) ──────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <FieldLabel>Transform (field map)</FieldLabel>
          <Segmented
            value={builderMode ? "guided" : "raw"}
            onChange={(v) => setBuilderMode(v === "guided")}
            options={[
              { value: "raw", label: "Raw JSON", icon: "heroicons-outline:code-bracket" },
              { value: "guided", label: "Guided", icon: "heroicons-outline:sparkles" },
            ]}
          />
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
            onChange={(e: FieldChangeEvent) => {
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
        onChange={(e: FieldChangeEvent) => {
          setSchema(e.target.value);
          if (errors.schema) setErrors((p) => ({ ...p, schema: undefined }));
        }}
        placeholder='{ "type": "object", "properties": { ... } }'
        className="font-mono"
        error={errors.schema}
        hint="Optional JSON Schema to validate the transformed payload."
      />

      <Checkbox label="Active" checked={isActive} onChange={setIsActive} />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="action" icon="heroicons-outline:check" disabled={saving.isPending}>
          {saving.isPending ? "Saving…" : isEdit ? "Save changes" : "Create webhook"}
        </Button>
      </div>
    </form>
  );
}
