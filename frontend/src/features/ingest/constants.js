// Ingest shared constants — auth types + pill styles for webhooks and event logs.

export const AUTH_TYPES = [
  { value: "none", label: "None (open)" },
  { value: "api_key", label: "API key" },
  { value: "basic", label: "Basic auth" },
];

export const AUTH_PILL = {
  none: "bg-hover text-muted border-card-border",
  api_key: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  basic: "bg-amber-500/10 text-amber-500 border-amber-500/20",
};

export const authLabel = (t) => AUTH_TYPES.find((a) => a.value === t)?.label || t || "None";

// Event-log / test outcome pills (ok / failed / skipped).
export const OUTCOME_PILL = {
  ok: "bg-green-500/10 text-green-500",
  failed: "bg-red-500/10 text-red-500",
  skipped: "bg-hover text-muted",
};
