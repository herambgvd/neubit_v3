// Ingest shared constants — auth types + pill styles for webhooks and event logs.

export const AUTH_TYPES = [
  { value: "none", label: "None (open)" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "hmac", label: "HMAC signature" },
];

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
