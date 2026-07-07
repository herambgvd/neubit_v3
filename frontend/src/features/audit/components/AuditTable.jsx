"use client";

// The audit entries table — time / actor / action badge / activity columns,
// with loading + empty states. Presentational: parent owns the query + paging.
import { Badge, Card, EmptyState, Spinner, Table } from "@/components/ui/kit";
import { actionColor, describe, formatTs } from "../auditFormat";

const columns = [
  {
    key: "ts",
    label: "Time",
    render: (r) => <span className="text-muted text-muted">{formatTs(r.ts)}</span>,
  },
  {
    key: "actor_email",
    label: "Actor",
    render: (r) => <span className="font-medium">{r.actor_email || "—"}</span>,
  },
  {
    key: "action",
    label: "Action",
    render: (r) => <Badge color={actionColor(r.action)}>{r.action || "—"}</Badge>,
  },
  {
    key: "activity",
    label: "Activity",
    render: (r) => <span className="text-foreground">{describe(r)}</span>,
  },
];

export default function AuditTable({ items, loading }) {
  return (
    <Card className="p-2">
      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="heroicons-outline:document-text"
          title="No audit entries yet"
          subtitle="Actions performed in the app will appear here."
        />
      ) : (
        <Table columns={columns} rows={items} />
      )}
    </Card>
  );
}
