"use client";

// Column definitions for the API keys table.
import { RowAction } from "@/components/console";
import { Badge, type TableColumn } from "@/components/ui/kit";
import type { ApiKeyOut } from "../../types";
import { apiKeyStatus, fmtDate } from "../format";

const STATUS: Record<ReturnType<typeof apiKeyStatus>, { label: string; color: "green" | "amber" | "slate" }> = {
  active: { label: "Active", color: "green" },
  // Amber, not slate: an expired key is refused like a revoked one, but nobody
  // decided that — it happened, and it is the row someone has to act on.
  expired: { label: "Expired", color: "amber" },
  revoked: { label: "Revoked", color: "slate" },
};

export function buildApiKeyColumns({ onRevoke }: { onRevoke: (key: ApiKeyOut) => void }): TableColumn<ApiKeyOut>[] {
  return [
    {
      key: "name",
      label: "Name",
      render: (k) => (
        <div>
          <div className="font-medium text-nb-ink">{k.name}</div>
          {k.description && <div className="text-[11px] text-nb-faint">{k.description}</div>}
        </div>
      ),
    },
    {
      key: "prefix",
      label: "Key",
      render: (k) => <span className="font-mono text-xs text-nb-muted">{k.prefix}…</span>,
    },
    {
      key: "role",
      label: "Role",
      render: (k) => k.role?.name || "—",
    },
    {
      key: "created_at",
      label: "Created",
      render: (k) => <span className="text-nb-muted">{fmtDate(k.created_at)}</span>,
    },
    {
      key: "last_used_at",
      label: "Last used",
      // "Never" and "—" are different facts: a key that has never been exchanged
      // is a candidate for deletion, and a dash reads as missing data.
      render: (k) => (
        <span className="text-nb-muted">{k.last_used_at ? fmtDate(k.last_used_at) : "Never"}</span>
      ),
    },
    {
      key: "expires_at",
      label: "Expires",
      // Shown because the STATUS depends on it. Without the date, an "Expired"
      // badge is a verdict with nothing behind it, and a key expiring next week
      // looks exactly like one expiring in a year.
      render: (k) => (
        <span className={apiKeyStatus(k) === "expired" ? "text-nb-warn" : "text-nb-muted"}>
          {k.expires_at ? fmtDate(k.expires_at) : "Never"}
        </span>
      ),
    },
    {
      key: "status",
      label: "Status",
      render: (k) => {
        const s = STATUS[apiKeyStatus(k)];
        return <Badge color={s.color}>{s.label}</Badge>;
      },
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (k) =>
        // An expired key is still revocable: it is refused today, but revoking is
        // what stops it coming back if someone extends the expiry.
        k.is_active && !k.revoked_at ? (
          <RowAction
            icon="heroicons-outline:trash"
            title={`Revoke ${k.name}`}
            tone="danger"
            onClick={() => onRevoke(k)}
          />
        ) : null,
    },
  ];
}
