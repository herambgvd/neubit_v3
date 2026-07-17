// Ingest shared constants — auth types, event-log statuses, and pill styles.

export const AUTH_TYPES = [
  { value: "none", label: "None (open endpoint)" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic auth (user + password)" },
  { value: "bearer", label: "Bearer token" },
  { value: "hmac", label: "HMAC signature (sha256)" },
];

// Permission keys the backend gates the ingest routes on (router.py).
export const PERM_READ = "ingest.read";
export const PERM_MANAGE = "ingest.manage";

export const AUTH_PILL = {
  none: "bg-hover text-muted border-card-border",
  api_key: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  basic: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  bearer: "bg-violet-500/10 text-violet-500 border-violet-500/20",
  hmac: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
};

export const authLabel = (t) => AUTH_TYPES.find((a) => a.value === t)?.label || t || "None";

// Request method for the inbound receiver: POST reads a JSON body, GET reads
// query params as the payload.
export const REQUEST_METHODS = [
  { value: "post", label: "POST (JSON body)" },
  { value: "get", label: "GET (query params)" },
];

// Event-log / test outcome pills (ok / failed / skipped).
export const OUTCOME_PILL = {
  ok: "bg-green-500/10 text-green-500",
  failed: "bg-red-500/10 text-red-500",
  skipped: "bg-hover text-muted",
};

// ── Event-log status (the single-value verdict; EventStatus in schemas.py) ──

// The sentinel for "no filter" — "" would be dropped by api.js's qs().
export const STATUS_ALL = "_all_";

export const STATUS_FILTERS = [
  { value: STATUS_ALL, label: "All" },
  { value: "accepted", label: "Accepted" },
  { value: "no_rule_match", label: "No rule match" },
  { value: "rejected_auth", label: "Rejected (auth)" },
  { value: "rejected_schema", label: "Rejected (schema)" },
  { value: "rejected_method", label: "Rejected (method)" },
  { value: "transform_failed", label: "Transform failed" },
  { value: "unresolved_device", label: "Unresolved device" },
  { value: "publish_failed", label: "Publish failed" },
];

export const STATUS_LABEL = Object.fromEntries(
  STATUS_FILTERS.map((s) => [s.value, s.label]),
);

// Only "accepted" published. The rest are all failures, but they differ in who
// has to fix them: auth/schema/method are the SENDER's problem, while
// no_rule_match / transform_failed / publish_failed are ours — hence amber.
export const STATUS_PILL = {
  accepted: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  no_rule_match: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  transform_failed: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  unresolved_device: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  publish_failed: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  rejected_auth: "bg-red-500/10 text-red-500 border-red-500/20",
  rejected_schema: "bg-red-500/10 text-red-500 border-red-500/20",
  rejected_method: "bg-red-500/10 text-red-500 border-red-500/20",
};
