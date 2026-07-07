// Workflow domain constants — incident lifecycle statuses/priorities and their
// kit-Badge color mappings. Extracted from IncidentList so both the list and the
// detail page (and any future incident view) share one source of truth.

// Domain statuses mirror neubit_v2's incident lifecycle (pending→active→…→completed).
export const INCIDENT_STATUSES = ["pending", "active", "paused", "completed", "cancelled"];
export const PRIORITIES = ["low", "medium", "high", "critical"];

// status → kit Badge color
export const STATUS_COLOR = {
  pending: "amber",
  active: "blue",
  paused: "amber",
  completed: "green",
  cancelled: "neutral",
};
// priority → kit Badge color
export const PRIORITY_COLOR = {
  low: "slate",
  medium: "blue",
  high: "amber",
  critical: "red",
};
