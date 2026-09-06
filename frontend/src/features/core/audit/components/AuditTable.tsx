"use client";

// The audit entries table — time / actor / action badge / activity columns,
// with loading + empty states. Presentational: parent owns the query + paging.
import { Badge, Card, EmptyState, Spinner, Table, type TableColumn } from "@/components/ui/kit";
import type { AuditLogOut } from "../../types";
import { actionColor, describe, formatTs } from "../auditFormat";

const columns: TableColumn<AuditLogOut>[] = [
  {
    key: "ts",
    label: "Time",
    render: (r) => <span className="text-nb-muted text-nb-muted">{formatTs(r.ts)}</span>,
  },
  {
    key: "actor_name",
    label: "Actor",
    // Name first; email is the fallback for rows recorded before names were snapshotted.
    render: (r) => (
      <span className="font-medium" title={r.actor_email || undefined}>
        {r.actor_name || r.actor_email || "System"}
      </span>
    ),
  },
  {
    key: "action",
    label: "Action",
    render: (r) => <Badge color={actionColor(r.action)}>{r.action || "—"}</Badge>,
  },
  {
    key: "activity",
    label: "Activity",
    render: (r) => <span className="text-nb-ink">{describe(r)}</span>,
  },
];

export default function AuditTable({ items, loading }: { items: AuditLogOut[]; loading: boolean }) {
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
