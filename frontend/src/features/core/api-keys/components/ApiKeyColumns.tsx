"use client";

// Column definitions for the API keys table.
//
// TanStack defs for the shared `DataTable`, not the kit's own `Table`. The
// console had TWO table components — a simple one used by this screen alone and
// a TanStack one used by nobody, orphaned when the VMS cleanup removed its only
// caller. One table everywhere beats two, and the richer one is the one worth
// keeping: sorting is the whole job on a key audit ("what expires next", "what
// has never been used").
import type { ColumnDef } from "@tanstack/react-table";

import { RowAction } from "@/components/console";
import { Badge } from "@/components/ui/kit";
import type { ApiKeyOut } from "../../types";
import { apiKeyStatus, fmtDate, type ApiKeyStatus } from "../format";

const STATUS: Record<ApiKeyStatus, { label: string; color: "green" | "amber" | "slate" }> = {
  active: { label: "Active", color: "green" },
  // Amber, not slate: an expired key is refused like a revoked one, but nobody
  // decided that — it happened, and it is the row someone has to act on.
  expired: { label: "Expired", color: "amber" },
  revoked: { label: "Revoked", color: "slate" },
};

/** Sorts empty dates LAST rather than first, whichever direction is chosen. */
const dateKey = (v: string | null) => (v ? new Date(v).getTime() : Number.NEGATIVE_INFINITY);

export function buildApiKeyColumns({
  onRevoke,
}: {
  onRevoke: (key: ApiKeyOut) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): ColumnDef<ApiKeyOut, any>[] {
  return [
    {
      id: "name",
      header: "Name",
      accessorFn: (k) => k.name,
      cell: ({ row }) => (
        <div>
          <div className="font-medium text-nb-ink">{row.original.name}</div>
          {row.original.description && (
            <div className="text-[11px] text-nb-faint">{row.original.description}</div>
          )}
        </div>
      ),
    },
    {
      id: "prefix",
      header: "Key",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs text-nb-muted">{row.original.prefix}…</span>
      ),
    },
    {
      id: "role",
      header: "Role",
      accessorFn: (k) => k.role?.name || "",
      cell: ({ row }) => row.original.role?.name || "—",
    },
    {
      id: "created_at",
      header: "Created",
      accessorFn: (k) => dateKey(k.created_at),
      cell: ({ row }) => <span className="text-nb-muted">{fmtDate(row.original.created_at)}</span>,
    },
    {
      id: "last_used_at",
      header: "Last used",
      accessorFn: (k) => dateKey(k.last_used_at),
      // "Never" and "—" are different facts: a key that has never been exchanged
      // is a candidate for deletion, and a dash reads as missing data.
      cell: ({ row }) => (
        <span className="text-nb-muted">
          {row.original.last_used_at ? fmtDate(row.original.last_used_at) : "Never"}
        </span>
      ),
    },
    {
      id: "expires_at",
      header: "Expires",
      accessorFn: (k) => dateKey(k.expires_at),
      // Shown because the STATUS depends on it. Without the date, an "Expired"
      // badge is a verdict with nothing behind it, and a key expiring next week
      // looks exactly like one expiring in a year.
      cell: ({ row }) => (
        <span className={apiKeyStatus(row.original) === "expired" ? "text-nb-warn" : "text-nb-muted"}>
          {row.original.expires_at ? fmtDate(row.original.expires_at) : "Never"}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessorFn: (k) => apiKeyStatus(k),
      cell: ({ row }) => {
        const s = STATUS[apiKeyStatus(row.original)];
        return <Badge color={s.color}>{s.label}</Badge>;
      },
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      meta: { align: "right" },
      cell: ({ row }) =>
        // An expired key is still revocable: it is refused today, but revoking is
        // what stops it coming back if someone extends the expiry.
        row.original.is_active && !row.original.revoked_at ? (
          <RowAction
            icon="heroicons-outline:trash"
            title={`Revoke ${row.original.name}`}
            tone="danger"
            onClick={() => onRevoke(row.original)}
          />
        ) : null,
    },
  ];
}
