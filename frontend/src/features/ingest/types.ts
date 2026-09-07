// Wire types local to the ingest feature (categories, webhooks, event rules,
// event logs, dry-run results). Each interface mirrors one Pydantic model in
// backend/ingest/app/ingest/schemas.py. Dates cross the wire as ISO-8601
// strings; vendor payloads and JSON-Schema documents are genuinely dynamic and
// are typed `JsonValue` / `Record<string, unknown>`, never `any`.
//
// The UI-only draft shapes (builder fields, condition rows, field-map rows) sit
// at the bottom — they are what the forms edit before they become wire bodies.

/* --- JSON --------------------------------------------------------------- */

/** Any value that survives JSON.parse — an inbound payload, a schema document,
 *  a matcher's expected/actual value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON object: an inbound payload body, a JSON-Schema document, an extracted
 *  result. Keys are unknown until the operator's sample says otherwise. */
export type JsonObject = Record<string, unknown>;

/* --- Enums (schemas.py) -------------------------------------------------- */

/** `AuthType`. */
export type AuthType = "none" | "api_key" | "basic" | "bearer" | "hmac";

/** `InboundMethod` — "post" reads the body, "get" reads query params. */
export type InboundMethod = "post" | "get";

/** `EventStatus` — the single-value verdict on one inbound delivery. */
export type EventStatus =
  | "accepted"
  | "rejected_auth"
  | "rejected_schema"
  | "rejected_method"
  | "transform_failed"
  | "no_rule_match"
  | "unresolved_device"
  | "publish_failed";

/** `MatchOp` — the five matcher operators. */
export type MatchOp = "exists" | "not_exists" | "equals" | "not_equals" | "contains";

/* --- Category ------------------------------------------------------------ */

/** `CategoryPublic`. */
export interface CategoryPublic {
  id: string;
  name: string;
  description: string | null;
  /** Routing domain interpolated into the published NATS subject. Never one of
   *  the backend's RESERVED_DOMAINS (access/core/vms/… belong to other services). */
  target_domain: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  webhook_count: number;
}

/** `CategoryCreate`. */
export interface CategoryCreate {
  name: string;
  description?: string | null;
  target_domain?: string;
}

/** `CategoryUpdate` — PATCH semantics; only sent fields change. */
export interface CategoryUpdate {
  name?: string | null;
  description?: string | null;
  target_domain?: string | null;
  is_active?: boolean | null;
}

/** `CategoryListResponse`. */
export interface CategoryListResponse {
  items: CategoryPublic[];
  total: number;
  skip: number;
  limit: number;
}

/* --- Webhook ------------------------------------------------------------- */

/** `WebhookPublic`. `auth_secret` is write-only — only `has_secret` comes back. */
export interface WebhookPublic {
  id: string;
  category_id: string;
  name: string;
  /** Operator-chosen last segment of the public receiver URL; immutable. */
  slug: string;
  description: string | null;
  request_method: InboundMethod;
  auth_type: AuthType;
  auth_username: string | null;
  has_secret: boolean;
  /** JSON Schema document validating the inbound payload. */
  payload_schema: JsonObject;
  /** { outKey: JMESPath } over the inbound payload. */
  transform: Record<string, string>;
  device_lookup_expr: string | null;
  event_type: string;
  is_active: boolean;
  /** Absolute when the service knows its public base URL, else the bare path. */
  ingest_url: string | null;
  created_at: string;
  updated_at: string;
}

/** `WebhookCreate`. */
export interface WebhookCreate {
  category_id: string;
  name: string;
  slug: string;
  description?: string | null;
  request_method?: InboundMethod;
  auth_type?: AuthType;
  auth_username?: string | null;
  auth_secret?: string | null;
  payload_schema?: JsonObject;
  transform?: Record<string, string>;
  device_lookup_expr?: string | null;
  event_type?: string;
  is_active?: boolean;
}

/** `WebhookUpdate` — note there is no `slug`: it is fixed at create time and the
 *  backend 422s on an attempt to change it. */
export interface WebhookUpdate {
  category_id?: string | null;
  name?: string | null;
  description?: string | null;
  request_method?: InboundMethod | null;
  auth_type?: AuthType | null;
  auth_username?: string | null;
  /** Provide to rotate the secret; omit to leave it unchanged. */
  auth_secret?: string | null;
  payload_schema?: JsonObject | null;
  transform?: Record<string, string> | null;
  device_lookup_expr?: string | null;
  event_type?: string | null;
  is_active?: boolean | null;
}

/** `WebhookListResponse`. */
export interface WebhookListResponse {
  items: WebhookPublic[];
  total: number;
  skip: number;
  limit: number;
}

/** `RotateSecretResponse` — the plaintext secret is returned ONCE. */
export interface RotateSecretResponse {
  id: string;
  slug: string;
  ingest_url: string;
  auth_secret: string;
}

/** `WebhookTestResponse` — dry-run outcome; nothing published, nothing logged. */
export interface WebhookTestResponse {
  schema_valid: boolean;
  schema_errors: string[];
  transformed: JsonValue | null;
  transform_errors: string[];
  would_publish: boolean;
  reject_reason: string | null;
  would_publish_subject: string | null;
  auth_type: AuthType;
  resolved_event_type: string | null;
  matched_rule_id: string | null;
  matched_rule_name: string | null;
  device_lookup_value: string | null;
  resolved_device_id: string | null;
}

/* --- Event logs ---------------------------------------------------------- */

/** `EventLogSummary` — the list row (no payload bodies). */
export interface EventLogSummary {
  id: string;
  webhook_id: string | null;
  category_id: string | null;
  received_at: string;
  source_ip: string | null;
  status: EventStatus;
  auth_outcome: string;
  schema_outcome: string;
  transform_outcome: string;
  published: boolean;
  target_subject: string | null;
  error: string | null;
  event_id: string | null;
  matched_rule_id: string | null;
  device_lookup_value: string | null;
  resolved_device_id: string | null;
  is_replay: boolean;
}

/** `EventLogDetail` — the summary plus the raw/transformed bodies. */
export interface EventLogDetailOut extends EventLogSummary {
  raw_payload: JsonValue | null;
  raw_truncated: boolean;
  transformed_payload: JsonValue | null;
}

/** `EventLogListResponse`. */
export interface EventLogListResponse {
  items: EventLogSummary[];
  total: number;
  skip: number;
  limit: number;
}

/** `ReplayResponse`. */
export interface ReplayResponse {
  replay_log_id: string;
  published: boolean;
  event_id: string | null;
  target_subject: string | null;
  schema_outcome: string;
  transform_outcome: string;
  error: string | null;
}

/* --- Event rules --------------------------------------------------------- */

/** `MatchCondition` — one predicate on the (transformed) payload. `value` is
 *  required for equals/not_equals/contains and ignored for exists/not_exists. */
export interface MatchCondition {
  /** JMESPath (typically a simple dotted/indexed path). */
  path: string;
  op: MatchOp;
  value?: JsonValue;
}

/** `EventRulePublic`. */
export interface EventRulePublic {
  id: string;
  webhook_id: string;
  name: string;
  description: string | null;
  /** Lower runs first; the first matching rule wins. */
  priority: number;
  match_conditions: MatchCondition[];
  /** { outKey: JMESPath }. */
  field_map: Record<string, string>;
  event_type: string;
  /** Per-rule override of the category's routing domain. */
  target_domain: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** `EventRuleCreate`. */
export interface EventRuleCreate {
  name: string;
  description?: string | null;
  priority?: number;
  match_conditions?: MatchCondition[];
  field_map?: Record<string, string>;
  event_type?: string;
  target_domain?: string | null;
  enabled?: boolean;
}

/** `EventRuleUpdate` — PATCH semantics. */
export type EventRuleUpdate = Partial<EventRuleCreate>;

/** `EventRuleListResponse`. */
export interface EventRuleListResponse {
  items: EventRulePublic[];
  total: number;
}

/** `RuleTestRequest` — omit the overrides to test the persisted rule. */
export interface RuleTestRequest {
  payload: JsonObject;
  match_conditions?: MatchCondition[];
  field_map?: Record<string, string>;
}

/** One row of `RuleTestResponse.condition_results` (a dict on the wire; the
 *  matcher writes exactly these keys — see matcher.py `_evaluate_condition`). */
export interface ConditionResult {
  ok: boolean;
  op: MatchOp | string;
  path: string;
  actual?: unknown;
  expected?: unknown;
}

/** `RuleTestResponse`. */
export interface RuleTestResponse {
  matched: boolean;
  condition_results: ConditionResult[];
  extracted: Record<string, unknown> | null;
  event_type: string | null;
  /** Set only by the client-side preview (lib/rulePreview), never by the API. */
  _preview?: boolean;
}

/* --- UI-only draft shapes ------------------------------------------------ */

/** One row of the guided transform builder: a leaf path found in the sample,
 *  the output key it will be written to, and whether it is kept. */
export interface BuilderField {
  path: string;
  name: string;
  checked: boolean;
}

/** A match-condition row while it is being edited. `value` is the raw input text
 *  until `parseValue` turns it back into a JSON literal on submit. */
export interface ConditionDraft {
  path: string;
  op: MatchOp;
  value: string;
}

/** A field-map row while it is being edited. */
export interface FieldMapRow {
  outKey: string;
  jmespath: string;
}

/** The unsaved-rule draft the client-side preview evaluates. */
export interface RuleDraft {
  conditions: MatchCondition[];
  fieldMap: Record<string, string>;
  eventType?: string | null;
}
