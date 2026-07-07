// Friendly metadata per known template — icon + "when is this sent" description.
export const TEMPLATE_META = {
  alert: {
    icon: "heroicons-outline:bell-alert",
    desc: "Sent when an alert rule fires.",
  },
  report_ready: {
    icon: "heroicons-outline:document-chart-bar",
    desc: "Sent when a report finishes generating.",
  },
  welcome: {
    icon: "heroicons-outline:hand-raised",
    desc: "Sent to a new user after their account is created.",
  },
};

export function titleCase(name) {
  return (name || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
