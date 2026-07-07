"use client";

// Column definitions for the API keys table.
import { Badge, Button } from "@/components/ui/kit";
import { fmtDate } from "../format";

export function buildApiKeyColumns({ onRevoke }) {
  return [
    {
      key: "name",
      label: "Name",
      render: (k) => <div className="font-medium">{k.name}</div>,
    },
    {
      key: "prefix",
      label: "Key",
      render: (k) => (
        <span className="font-mono text-xs text-muted text-muted">{k.prefix}…</span>
      ),
    },
    {
      key: "role",
      label: "Role",
      render: (k) => k.role?.name || "—",
    },
    {
      key: "created_at",
      label: "Created",
      render: (k) => <span className="text-muted">{fmtDate(k.created_at)}</span>,
    },
    {
      key: "last_used_at",
      label: "Last used",
      render: (k) => <span className="text-muted">{fmtDate(k.last_used_at)}</span>,
    },
    {
      key: "is_active",
      label: "Status",
      render: (k) => <Badge color={k.is_active ? "green" : "slate"}>{k.is_active ? "Active" : "Revoked"}</Badge>,
    },
    {
      key: "actions",
      label: "",
      render: (k) =>
        k.is_active ? (
          <Button
            variant="danger"
            icon="heroicons-outline:trash"
            onClick={() => onRevoke(k)}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];
}
