"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldCheck, UserCheck, UserX, Users } from "lucide-react";
import { toast } from "sonner";

import { adminApi, apiError } from "@/lib/api";
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

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function UsersPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [disabling, setDisabling] = useState(null);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["users", { q, status, page }],
    queryFn: () => adminApi.listUsers({ page, pageSize: PAGE_SIZE, q, status }),
    placeholderData: keepPreviousData,
  });

  const users = data?.items ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? users.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const setActive = useMutation({
    mutationFn: ({ id, isActive }) => adminApi.setUserActive(id, isActive),
    onSuccess: (_r, vars) => {
      toast.success(vars.isActive ? "User enabled" : "User disabled");
      setDisabling(null);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err) => toast.error(apiError(err, "Could not update user")),
  });

  const columns = useMemo(
    () => [
      {
        accessorKey: "email",
        header: "User",
        cell: ({ row }) => {
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
        },
      },
      {
        accessorKey: "tenant_name",
        header: "Tenant",
        enableSorting: false,
        cell: ({ row }) => {
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
        },
      },
      {
        accessorKey: "role_name",
        header: "Role",
        enableSorting: false,
        cell: ({ row }) => <span className="text-foreground">{row.original.role_name || "—"}</span>,
      },
      {
        accessorKey: "is_active",
        header: "Status",
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="flex items-center gap-1.5">
              <Badge tone={u.is_active ? "success" : "neutral"} dot>
                {u.is_active ? "Active" : "Disabled"}
              </Badge>
              {!u.email_verified && <Badge tone="warning">Unverified</Badge>}
            </div>
          );
        },
      },
      {
        accessorKey: "last_login_at",
        header: "Last login",
        cell: ({ row }) => <span className="text-muted">{fmtDate(row.original.last_login_at)}</span>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const u = row.original;
          if (u.is_superadmin) return null; // platform admins aren't toggled here
          return u.is_active ? (
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                className="hover:border-danger/40 hover:text-danger"
                onClick={() => setDisabling(u)}
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
                loading={setActive.isPending && setActive.variables?.id === u.id}
                onClick={() => setActive.mutate({ id: u.id, isActive: true })}
              >
                <UserCheck className="h-3.5 w-3.5" /> Enable
              </Button>
            </div>
          );
        },
      },
    ],
    [setActive]
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
