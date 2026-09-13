"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck, UserCheck, UserX, Users } from "lucide-react";
import { toast } from "sonner";

import type { CellContext, ColumnDef } from "@tanstack/react-table";

import { adminApi, apiError } from "@/lib/api";
import { pagedItems, pagedTotal } from "@/lib/paged";
import type { AdminUser } from "@/lib/types";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Input,
  PageHeader,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui";

const PAGE_SIZE = 20;

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/* Cells live at module scope so their component type is fixed for the life of
   the module. Declared inside the page, each one would be a fresh type on every
   render and React would tear down and rebuild every cell in the table. */

type UserCell = CellContext<AdminUser, unknown>;

function UserIdentityCell({ row }: UserCell) {
  const u = row.original;
  const name = u.full_name || u.email;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-hover text-xs font-semibold text-foreground">
        {(name || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{name}</div>
        <div className="truncate text-xs text-muted">{u.email}</div>
      </div>
    </div>
  );
}

function TenantCell({ row }: UserCell) {
  const u = row.original;
  if (u.is_superadmin && !u.tenant_id) {
    return (
      <Badge tone="accent">
        <ShieldCheck className="h-3 w-3" /> Platform
      </Badge>
    );
  }
  if (!u.tenant_id) return <span className="text-muted">—</span>;
  return (
    <Link
      href={`/tenants/${u.tenant_id}`}
      onClick={(e) => e.stopPropagation()}
      className="text-foreground transition hover:text-accent"
    >
      {u.tenant_name || "—"}
      {u.tenant_slug && <span className="ml-1 font-mono text-xs text-muted">/{u.tenant_slug}</span>}
    </Link>
  );
}

function RoleCell({ row }: UserCell) {
  return <span className="text-foreground">{row.original.role_name || "—"}</span>;
}

function StatusCell({ row }: UserCell) {
  const u = row.original;
  return (
    <div className="flex items-center gap-1.5">
      <Badge tone={u.is_active ? "success" : "neutral"} dot>
        {u.is_active ? "Active" : "Disabled"}
      </Badge>
      {!u.email_verified && <Badge tone="warning">Unverified</Badge>}
    </div>
  );
}

function LastLoginCell({ row }: UserCell) {
  return <span className="text-muted">{fmtDate(row.original.last_login_at)}</span>;
}

function ActionsHeader() {
  return <span className="sr-only">Actions</span>;
}

function UserActionsCell({
  user: u,
  onDisable,
  onEnable,
  enabling,
}: {
  user: AdminUser;
  onDisable: (u: AdminUser) => void;
  onEnable: (id: string) => void;
  enabling: boolean;
}) {
  if (u.is_superadmin) return null; // platform admins aren't toggled here
  return u.is_active ? (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        className="hover:border-danger/40 hover:text-danger"
        onClick={() => onDisable(u)}
      >
        <UserX className="h-3.5 w-3.5" /> Disable
      </Button>
    </div>
  ) : (
    <div className="flex justify-end">
      <Button
        variant="outline"
        size="sm"
        className="hover:border-success/40 hover:text-success"
        loading={enabling}
        onClick={() => onEnable(u.id)}
      >
        <UserCheck className="h-3.5 w-3.5" /> Enable
      </Button>
    </div>
  );
}

// Everything the table needs from the page arrives as an argument, so no cell
// closes over a render of UsersPage.
function userColumns(
  onDisable: (u: AdminUser) => void,
  onEnable: (id: string) => void,
  enablingId: string | null
): ColumnDef<AdminUser, unknown>[] {
  return [
    { accessorKey: "email", header: "User", cell: UserIdentityCell },
    { accessorKey: "tenant_name", header: "Tenant", enableSorting: false, cell: TenantCell },
    { accessorKey: "role_name", header: "Role", enableSorting: false, cell: RoleCell },
    { accessorKey: "is_active", header: "Status", cell: StatusCell },
    { accessorKey: "last_login_at", header: "Last login", cell: LastLoginCell },
    {
      id: "actions",
      header: ActionsHeader,
      enableSorting: false,
      cell: ({ row }: UserCell) => (
        <UserActionsCell
          user={row.original}
          onDisable={onDisable}
          onEnable={onEnable}
          enabling={enablingId === row.original.id}
        />
      ),
    },
  ];
}

export default function UsersPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [disabling, setDisabling] = useState<AdminUser | null>(null);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["users", { q, status, page }],
    queryFn: () => adminApi.listUsers({ page, pageSize: PAGE_SIZE, q, status }),
    placeholderData: keepPreviousData,
  });

  const users = pagedItems(data);
  const total = pagedTotal(data);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      adminApi.setUserActive(id, isActive),
    onSuccess: (_r, vars) => {
      toast.success(vars.isActive ? "User enabled" : "User disabled");
      setDisabling(null);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not update user")),
  });

  // `mutate` is stable and `enablingId` only changes when a toggle starts or
  // finishes, so the column array holds still while the page re-renders on every
  // keystroke in the search box. Depending on the mutation object itself would
  // rebuild it every render — react-query returns a fresh one each time.
  const { mutate } = setActive;
  const enablingId = setActive.isPending ? (setActive.variables?.id ?? null) : null;
  const onEnable = useCallback((id: string) => mutate({ id, isActive: true }), [mutate]);
  const columns = useMemo(
    () => userColumns(setDisabling, onEnable, enablingId),
    [onEnable, enablingId]
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-[220px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Search email or name…"
          className="pl-9"
        />
      </div>
      <Tabs value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1); }}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="inactive">Disabled</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );

  return (
    <div>
      <PageHeader title="Users" description="Every user across all tenants on the platform." />

      <DataTable
        columns={columns}
        data={users}
        loading={isLoading}
        error={isError ? apiError(error, "Failed to load users") : null}
        toolbar={toolbar}
        empty={{
          icon: Users,
          title: q || status ? "No matching users" : "No users yet",
          description: q || status ? "Try a different search or filter." : "Users appear here as tenants add them.",
        }}
        pagination={{
          page,
          pages,
          isFetching,
          label: `${total} user${total === 1 ? "" : "s"}`,
          onPrev: () => setPage((p) => Math.max(1, p - 1)),
          onNext: () => setPage((p) => Math.min(pages, p + 1)),
        }}
      />

      <ConfirmDialog
        open={!!disabling}
        onOpenChange={(o) => !o && setDisabling(null)}
        title="Disable user?"
        description={disabling ? `${disabling.email} will be signed out and blocked from logging in until re-enabled.` : ""}
        confirmLabel="Disable user"
        loading={setActive.isPending}
        onConfirm={() => disabling && setActive.mutate({ id: disabling.id, isActive: false })}
      />
    </div>
  );
}
