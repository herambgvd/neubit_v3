// Workflow wire types — one interface per Pydantic model under
// backend/workflow/app/workflow/**/schemas.py (the file is named per block).
// Dates cross the wire as ISO-8601 strings; `dict` fields are
// `Record<string, unknown>` unless the service documents a shape (timeline
// entries, assignment, escalation, the trigger envelope). Enum-backed `str`
// columns are typed as the enum's literal union: the column only ever holds
// those values (core/enums.py).

import type { ThreatLevel } from "@/lib/types";

/* --- core/enums.py ---------------------------------------------------------- */

export type InstancePriority = "critical" | "high" | "medium" | "low";
/** `resolved` is v3's name for what v2 called `completed`. */
export type InstanceStatus = "pending" | "active" | "paused" | "resolved" | "cancelled";
export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "phone"
  | "date"
  | "datetime"
  | "select"
  | "radio"
  | "checkbox"
  | "boolean"
  | "file"
  | "rating"
  | "multiselect";

/* --- sops/schemas.py -------------------------------------------------------- */

export interface EscalationRule {
  after_hours: number;
  to_priority: InstancePriority;
  notify_role_ids: string[];
}

export interface SopPublic {
  sop_id: string;
  name: string;
  description: string | null;
  initial_state: string | null;
  priority: InstancePriority;
  trigger_event_types: string[];
  sla_hours: number | null;
  tags: string[];
  escalation_rules: EscalationRule[];
  version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateSopRequest {
  name: string;
  description?: string | null;
  priority?: InstancePriority;
  trigger_event_types?: string[];
  sla_hours?: number | null;
  tags?: string[];
  escalation_rules?: EscalationRule[];
  is_active?: boolean;
}

export type UpdateSopRequest = Partial<CreateSopRequest>;

export interface StatePublic {
  state_id: string;
  sop_id: string;
  name: string;
  description: string | null;
  color: string;
  position_x: number;
  position_y: number;
  is_initial: boolean;
  is_terminal: boolean;
  is_cancellation: boolean;
  sla_hours: number | null;
  entry_actions: Record<string, unknown>[];
  exit_actions: Record<string, unknown>[];
  required_role_ids: string[];
  order: number;
  created_at: string;
  updated_at: string;
}

export interface CreateStateRequest {
  name: string;
  description?: string | null;
  color?: string;
  position_x?: number;
  position_y?: number;
  is_initial?: boolean;
  is_terminal?: boolean;
  is_cancellation?: boolean;
  sla_hours?: number | null;
  entry_actions?: Record<string, unknown>[];
  exit_actions?: Record<string, unknown>[];
  required_role_ids?: string[];
  order?: number;
}

export type UpdateStateRequest = Partial<CreateStateRequest>;

/** `{field, operator, value}` — shared by transitions AND triggers (the trigger
 *  schema imports this class rather than redeclaring it). `field` is a dotted
 *  path into the envelope / instance context; see core/matching.py. */
export interface TransitionCondition {
  field: string;
  operator: string;
  value: unknown;
}

/** `notification_config` is an opaque dict on the backend; this is the shape
 *  the SOP designer (TransitionModal) writes and the instance service reads
 *  (`cfg.get("type", "none")`). */
export interface TransitionNotificationConfig {
  type: "none" | "email" | "sms" | "both";
  role_ids?: string[];
  user_ids?: string[];
  /** A CORE email template by name (Platform → Templates). It is rendered there
   *  — designer, variables, branded shell — and wins over the inline strings. */
  core_template?: string;
  email_subject?: string;
  email_body?: string;
  sms_message?: string;
}

export interface TransitionPublic {
  transition_id: string;
  sop_id: string;
  from_state_id: string;
  to_state_id: string;
  label: string;
  description: string | null;
  requires_note: boolean;
  confirmation_required: boolean;
  required_role_ids: string[];
  form_id: string | null;
  conditions: TransitionCondition[];
  notification_config: TransitionNotificationConfig | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTransitionRequest {
  from_state_id: string;
  to_state_id: string;
  label: string;
  description?: string | null;
  requires_note?: boolean;
  confirmation_required?: boolean;
  required_role_ids?: string[];
  form_id?: string | null;
  conditions?: TransitionCondition[];
  notification_config?: TransitionNotificationConfig | null;
}

export type UpdateTransitionRequest = Partial<CreateTransitionRequest>;

/* --- triggers/schemas.py ---------------------------------------------------- */

export type DedupStrategy = "per_event_type" | "per_event_id" | "per_field";

export interface DedupConfig {
  strategy: DedupStrategy;
  key_field?: string | null;
  window_seconds: number;
}

export interface TriggerPublic {
  trigger_id: string;
  name: string;
  description: string | null;
  sop_id: string;
  event_source: string;
  event_type: string;
  conditions: TransitionCondition[];
  /** `dict = {}` on the wire — an older row may carry an empty object. */
  dedup: Partial<DedupConfig>;
  priority: InstancePriority;
  auto_assign: Record<string, unknown> | null;
  assign_users: string[];
  enabled: boolean;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateTriggerRequest {
  name: string;
  description?: string | null;
  sop_id: string;
  /** Non-optional `str = ""` on create — send "" (not null) for "any source". */
  event_source?: string;
  /** Empty/None == match any event_type. */
  event_type?: string | null;
  conditions?: TransitionCondition[];
  dedup?: DedupConfig;
  priority?: InstancePriority;
  auto_assign?: Record<string, unknown> | null;
  assign_users?: string[];
  enabled?: boolean;
}

export type UpdateTriggerRequest = Partial<CreateTriggerRequest>;

export interface AlertFormatPublic {
  format_id: string;
  alert_code: string;
  name: string;
  description: string | null;
  /** security | performance | maintenance | system | custom */
  category: string;
  severity: string;
  priority: string;
  color_code: string;
  icon: string | null;
  alert_sound: boolean;
  sop_id: string | null;
  /** automatic | manual */
  sop_mode: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateAlertFormatRequest {
  alert_code: string;
  name: string;
  description?: string | null;
  category?: string;
  severity?: string;
  priority?: string;
  color_code?: string;
  icon?: string | null;
  alert_sound?: boolean;
  sop_id?: string | null;
  sop_mode?: string;
  is_active?: boolean;
}

export type UpdateAlertFormatRequest = Partial<CreateAlertFormatRequest>;

export interface SimulateEventRequest {
  event_type: string;
  payload?: Record<string, unknown>;
  site_id?: string | null;
  alert_code?: string | null;
  /** Default true: report without persisting. */
  dry_run?: boolean;
}

export interface SimulateMatchedTrigger {
  trigger_id: string;
  name: string;
  sop_id: string;
  would_create: boolean;
}

export interface SimulateMatchedFormat {
  format_id: string;
  alert_code: string;
  name: string;
  sop_id: string | null;
  sop_mode: string;
  would_create: boolean;
}

export interface SimulateSkipped {
  trigger_id: string | null;
  format_id: string | null;
  reason: string;
}

export interface SimulateEventResponse {
  dry_run: boolean;
  event_type: string;
  alert_code: string | null;
  matched_triggers: SimulateMatchedTrigger[];
  matched_format: SimulateMatchedFormat | null;
  skipped: SimulateSkipped[];
  created_instance_id: string | null;
  created_instance_ids: string[];
}

/* --- forms/schemas.py ------------------------------------------------------- */

/** One `options` entry — `list[dict]` on the wire; the builder writes both keys. */
export interface FormFieldOption {
  value: string;
  label: string;
}

/** `validation` dict — the keys forms/validation.py reads. */
export interface FormFieldValidation {
  required?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
}

/** `FormFieldSchema`. Stored as `model_dump()` so a read row carries every key;
 *  they are optional here because the Pydantic model defaults them on write. */
export interface FormFieldSchema {
  id?: string | null;
  label: string;
  type: FieldType;
  placeholder?: string | null;
  help_text?: string | null;
  default_value?: unknown;
  options?: FormFieldOption[];
  validation?: FormFieldValidation;
  order?: number;
  width?: string;
}

export interface FormPublic {
  form_id: string;
  name: string;
  description: string | null;
  fields: FormFieldSchema[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateFormRequest {
  name: string;
  description?: string | null;
  fields?: FormFieldSchema[];
  is_active?: boolean;
}

export type UpdateFormRequest = Partial<CreateFormRequest>;

/** What a rendered form field holds: text/number inputs, a boolean toggle, a
 *  multiselect's chosen values, or a file's name (the renderer stores the name). */
export type FormFieldValue = string | number | boolean | string[];
/** Filled form state, keyed by `fieldKey` — becomes a transition's `form_data`. */
export type FormValues = Record<string, FormFieldValue | undefined>;

/* --- instances/schemas.py --------------------------------------------------- */

/** The originating EventBus envelope stored in `trigger_data` (correlation/
 *  engine.py: `{event_id, tenant_id, type, occurred_at, source, payload}`, plus
 *  `site_id` flattened up from the payload). Publishers may add keys. */
export interface TriggerEnvelope {
  event_id?: string;
  tenant_id?: string;
  type?: string;
  occurred_at?: string;
  source?: string;
  site_id?: string | null;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One `timeline` entry, as `InstanceService.transition` appends it. */
export interface TimelineEntry {
  transition_id: string;
  transition_name: string;
  from_state_id: string;
  from_state_name: string;
  to_state_id: string;
  to_state_name: string;
  executed_by: string;
  executed_by_name: string | null;
  notes: string | null;
  form_data: Record<string, unknown> | null;
  form_labels: Record<string, string> | null;
  executed_at: string;
}

/** `assignment`, as `InstanceService.assign` writes it. */
export interface InstanceAssignment {
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_role: string | null;
  assigned_role_name: string | null;
  assigned_at: string;
}

/** `escalation`, as `InstanceService.escalate` writes it. */
export interface InstanceEscalation {
  level: number;
  escalated_at: string;
  escalated_by: string | null;
  reason: string | null;
}

export interface InstancePublic {
  instance_id: string;
  sop_id: string;
  sop_name: string;
  sop_version: number;
  name: string | null;
  description: string | null;
  priority: InstancePriority;
  site_id: string | null;
  current_state: string | null;
  current_state_name: string | null;
  status: InstanceStatus;
  assigned_to: string | null;
  assignment: InstanceAssignment | null;
  sla_hours: number | null;
  sla_deadline: string | null;
  is_sla_breached: boolean;
  state_entered_at: string | null;
  escalation: InstanceEscalation | null;
  tags: string[];
  timeline: TimelineEntry[];
  metadata: Record<string, unknown> | null;
  trigger_data: TriggerEnvelope | null;
  event_id: string | null;
  event_type: string | null;
  /** EventBus domain tag ("vision" | "access" | "ingest" | …); "manual" when
   *  operator-raised. Derived from the envelope, not a column. */
  event_source: string | null;
  /** The originating event's OWN id (differs from the bus-envelope `event_id`). */
  source_event_id: string | null;
  closed_at: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

/** Zero-filled counts; `by_status` also carries the `completed` alias of `resolved`. */
export interface InstanceStatsResponse {
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
  total: number;
}

export interface TransitionInstanceRequest {
  transition_id: string;
  notes?: string | null;
  form_data?: Record<string, unknown> | null;
}

export interface AssignInstanceRequest {
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  assigned_role?: string | null;
  assigned_role_name?: string | null;
}

export interface StatusChangeRequest {
  status: InstanceStatus;
  outcome?: string | null;
}

export interface EscalateInstanceRequest {
  reason?: string | null;
}

/* --- notifications/schemas.py ---------------------------------------------- */

export interface TemplatePublic {
  template_id: string;
  name: string;
  description: string | null;
  /** email | webhook | whatsapp | mobile_push | sms */
  channel_type: string;
  subject: string | null;
  body: string;
  provider_template_ref: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateRequest {
  name: string;
  description?: string | null;
  channel_type?: string;
  subject?: string | null;
  body: string;
  provider_template_ref?: string | null;
  is_active?: boolean;
}

export type UpdateTemplateRequest = Partial<CreateTemplateRequest>;

/** `config` comes back with every credential field redacted. */
export interface ChannelPublic {
  channel_id: string;
  name: string;
  channel_type: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateChannelRequest {
  name: string;
  channel_type: string;
  config?: Record<string, unknown>;
  is_enabled?: boolean;
  is_default?: boolean;
}

export type UpdateChannelRequest = Partial<CreateChannelRequest>;

/* --- threat_levels/schemas.py ---------------------------------------------- */

export interface ThreatLevelPublic {
  id: string;
  /** Null == deployment-wide. */
  site_id: string | null;
  level: ThreatLevel;
  reason: string | null;
  set_by: string | null;
  /** The acting user's display name, stamped at write time. Null for a system
   *  change or a row written before the name was recorded — show `set_by` then. */
  set_by_name: string | null;
  set_at: string;
  history: Record<string, unknown>[];
}

export interface SetThreatLevelRequest {
  level: ThreatLevel;
  reason?: string | null;
  site_id?: string | null;
}

/* --- core auth rows this feature reads ------------------------------------- */
// The user/role pickers call core's GET /auth/users and /auth/roles
// (backend/core/app/auth/schemas.py :: UserOut / RoleOut, paged as `Page[T]`).
// Only the fields the pickers render are declared: a subset view, not the model.

export interface AssignableUser {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url?: string | null;
}

export interface AssignableRole {
  id: string;
  name: string;
  description: string | null;
}

/* --- frontend-only shapes ---------------------------------------------------- */

/** `{ id → display name }` lookups the incident views build from the SOP / site
 *  lists; a miss is `undefined`. */
export type NameMap = Record<string, string | undefined>;

/** A stream frame from the core realtime bridge (`incident.created` /
 *  `trigger.fired`). `data` is the emitted payload dict, or null when the frame
 *  body was not JSON (a keepalive). */
export interface IncidentStreamEvent {
  type: string;
  data: Record<string, unknown> | null;
}

/* --- narrowing helpers for the `unknown` fields above ---------------------- */

/** A plain JSON object (not null, not an array). */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The value as a string when it is one (or a number), else null. */
export const asStr = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
