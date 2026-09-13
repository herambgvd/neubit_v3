"use client";

import { useState, type FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ScrollText, Search } from "lucide-react";

import type { CellContext, ColumnDef } from "@tanstack/react-table";

import { adminApi, apiError } from "@/lib/api";
import type { AuditEntry } from "@/lib/types";
import { Badge, Button, DataTable, Input, PageHeader, type BadgeTone } from "@/components/ui";

function fmtTs(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Map action verbs → tone. create=success, delete/suspend=danger, update=warning, else neutral.
function actionTone(action: string | null | undefined): BadgeTone {
  const a = (action || "").toLowerCase();
  if (/(create|add|reactivate|start|grant|login)/.test(a)) return "success";
  if (/(delete|remove|suspend|revoke|stop|fail)/.test(a)) return "danger";
  if (/(update|patch|edit|change|scale|set)/.test(a)) return "warning";
  return "foreground";
}

/* Cells live at module scope so their component type is fixed for the life of
   the module. Declared inside the page, each one would be a fresh type on every
   render and React would tear down and rebuild every cell in the table. */

type AuditCell = CellContext<AuditEntry, unknown>;

function TimeCell({ row }: AuditCell) {
  return <span className="whitespace-nowrap tabular-nums text-muted">{fmtTs(row.original.ts)}</span>;
}

function ActorCell({ row }: AuditCell) {
  return (
    <span className="font-medium text-foreground">
      {row.original.actor_name || row.original.actor_email || "—"}
    </span>
  );
}

function ActionCell({ row }: AuditCell) {
  return <Badge tone={actionTone(row.original.action)}>{row.original.action || "—"}</Badge>;
}

function TargetCell({ row }: AuditCell) {
  if (!row.original.target_type && !row.original.target_id) {
    return <span className="text-muted">—</span>;
  }
  return (
    <span>
      <span className="text-muted">{row.original.target_type || "—"}</span>
      {row.original.target_id ? (
        <span className="font-mono text-xs text-muted"> · {row.original.target_id}</span>
      ) : null}
    </span>
  );
}

// Nothing here depends on page state, so the array itself is a constant too.
const COLUMNS: ColumnDef<AuditEntry, unknown>[] = [
  { accessorKey: "ts", header: "Time", cell: TimeCell },
  {
    // The row carries actor_name/actor_email (there is no flat `actor`
    // field) — prefer the display name and fall back to the address.
    accessorKey: "actor_email",
    header: "Actor",
    enableSorting: false,
    cell: ActorCell,
  },
  { accessorKey: "action", header: "Action", enableSorting: false, cell: ActionCell },
  { accessorKey: "target_type", header: "Target", enableSorting: false, cell: TargetCell },
];

export default function AuditPage() {
  const [tenantInput, setTenantInput] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["audit", { tenantId, page }],
    queryFn: () => adminApi.listAudit({ tenantId, page }),
    placeholderData: keepPreviousData,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const pageSize = data?.page_size || items.length || 20;
  const pages = Math.max(1, Math.ceil(total / (pageSize || 20)));

  function applyFilter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTenantId(tenantInput.trim());
    setPage(1);
  }

  const toolbar = (
    <form onSubmit={applyFilter} className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          value={tenantInput}
          onChange={(e) => setTenantInput(e.target.value)}
          placeholder="Filter by tenant_id (leave blank for all)…"
          className="pl-9"
        />
      </div>
      <Button type="submit" variant="outline">
        Apply
      </Button>
      {tenantId && (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setTenantInput("");
            setTenantId("");
            setPage(1);
          }}
        >
          Clear
        </Button>
      )}
    </form>
  );

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Cross-tenant record of privileged actions. Filter by a specific tenant or view all."
      />

      <DataTable
        columns={COLUMNS}
        data={items}
        loading={isLoading}
        error={isError ? apiError(error, "Failed to load audit log") : null}
        toolbar={toolbar}
        empty={{
          icon: ScrollText,
          title: "No audit entries",
          description: tenantId ? "No activity for this tenant." : "No privileged actions recorded yet.",
        }}
        pagination={{
          page,
          pages,
          isFetching,
          label: `${total} entr${total === 1 ? "y" : "ies"}`,
          onPrev: () => setPage((p) => Math.max(1, p - 1)),
          onNext: () => setPage((p) => Math.min(pages, p + 1)),
        }}
      />
    </div>
  );
}
