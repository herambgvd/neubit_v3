// Ingest shared constants — auth types + pill styles for webhooks and event logs.

export const AUTH_TYPES = [
  { value: "none", label: "None (open)" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic auth" },
  { value: "bearer", label: "Bearer token" },
  { value: "hmac", label: "HMAC signature" },
];

export const AUTH_PILL = {
  none: "bg-[rgba(10,18,40,.6)] text-nb-faint border-nb-line",
  api_key: "bg-[rgba(96,165,250,.1)] text-nb-blueb border-[rgba(96,165,250,.35)]",
  basic: "bg-[rgba(251,191,36,.1)] text-nb-warn border-[rgba(251,191,36,.35)]",
  bearer: "bg-[rgba(167,139,250,.12)] text-nb-violetb border-[rgba(167,139,250,.35)]",
  hmac: "bg-[rgba(52,211,153,.1)] text-nb-good border-[rgba(52,211,153,.35)]",
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
  ok: "border border-[rgba(52,211,153,.5)] bg-[rgba(52,211,153,.1)] text-nb-good",
  failed: "border border-[rgba(248,113,113,.5)] bg-[rgba(248,113,113,.1)] text-nb-crit",
  skipped: "border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-faint",
};
