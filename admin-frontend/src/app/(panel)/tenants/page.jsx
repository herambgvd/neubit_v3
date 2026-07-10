"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Search, Users } from "lucide-react";
import { toast } from "sonner";
import * as yup from "yup";

import { adminApi, apiError } from "@/lib/api";
import { useAdminForm } from "@/lib/useAdminForm";
import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
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

function StatusBadge({ status }) {
  const active = status !== "suspended";
  return (
    <Badge tone={active ? "success" : "warning"} dot>
      {active ? "Active" : "Suspended"}
    </Badge>
  );
}

function LicenseBadge({ state }) {
  const map = {
    active: ["foreground", "Licensed"],
    grace: ["warning", "Grace"],
    expired: ["danger", "Expired"],
  };
  const [tone, label] = map[state] || map.active;
  return <Badge tone={tone}>{label}</Badge>;
}

export default function TenantsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["tenants", { q, status, page }],
    queryFn: () => adminApi.listTenants({ page, pageSize: PAGE_SIZE, q, status }),
    placeholderData: keepPreviousData,
  });

  const tenants = data?.items ?? (Array.isArray(data) ? data : []);
  const total = data?.total ?? tenants.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div>
            <Link
              href={`/tenants/${row.original.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-medium text-foreground transition hover:text-accent"
            >
              {row.original.name}
            </Link>
            <div className="font-mono text-xs text-muted">{row.original.slug}</div>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "license_state",
        header: "License",
        cell: ({ row }) => <LicenseBadge state={row.original.license_state} />,
      },
      {
        accessorKey: "plan",
        header: "Plan",
        cell: ({ row }) => <span className="text-foreground">{row.original.plan || "—"}</span>,
      },
      {
        accessorKey: "users",
        header: "Users",
        cell: ({ row }) => (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <Users className="h-3.5 w-3.5 text-muted" />
            {row.original.users ?? 0}
          </span>
        ),
      },
      {
        accessorKey: "created_at",
        header: "Created",
        cell: ({ row }) => <span className="text-muted">{fmtDate(row.original.created_at)}</span>,
      },
    ],
    []
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
          placeholder="Search name or slug…"
          className="pl-9"
        />
      </div>
      <Tabs value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1); }}>
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="active">Active</TabsTrigger>
          <TabsTrigger value="suspended">Suspended</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Tenants"
        description="Manage every organization on the platform."
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Create tenant
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={tenants}
        loading={isLoading}
        error={isError ? apiError(error, "Failed to load tenants") : null}
        onRowClick={(t) => router.push(`/tenants/${t.id}`)}
        toolbar={toolbar}
        empty={{
          icon: Building2,
          title: q || status ? "No matching tenants" : "No tenants yet",
          description: q || status ? "Try a different search or filter." : "Create your first tenant.",
        }}
        pagination={{
          page,
          pages,
          isFetching,
          label: `${total} tenant${total === 1 ? "" : "s"}`,
          onPrev: () => setPage((p) => Math.max(1, p - 1)),
          onNext: () => setPage((p) => Math.min(pages, p + 1)),
        }}
      />

      <CreateTenantModal
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false);
          qc.invalidateQueries({ queryKey: ["tenants"] });
        }}
      />
    </div>
  );
}

const createSchema = yup.object({
  name: yup.string().trim().required("Organization name is required"),
  admin_email: yup.string().trim().email("Enter a valid email").required("Admin email is required"),
  admin_password: yup.string().min(8, "At least 8 characters").required("Password is required"),
});

function CreateTenantModal({ open, onOpenChange, onCreated }) {
  const form = useAdminForm(createSchema, { name: "", admin_email: "", admin_password: "" });
  const { errors } = form.formState;

  const create = useMutation({
    mutationFn: (values) =>
      adminApi.createTenant({
        name: values.name.trim(),
        admin_email: values.admin_email.trim(),
        admin_password: values.admin_password,
      }),
    onSuccess: () => {
      toast.success("Tenant created");
      form.reset();
      onCreated();
    },
    onError: (err) => toast.error(apiError(err, "Could not create tenant")),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) form.reset();
        onOpenChange(o);
      }}
    >
      <DialogContent>
        <DialogHeader title="Create tenant" description="Provision an organization and its first admin." />
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="space-y-4" noValidate>
          <Field label="Organization name" required error={errors.name?.message}>
            <Input placeholder="Acme Corporation" autoFocus invalid={!!errors.name} {...form.register("name")} />
          </Field>
          <Field label="Admin email" required error={errors.admin_email?.message}>
            <Input type="email" placeholder="admin@acme.com" invalid={!!errors.admin_email} {...form.register("admin_email")} />
          </Field>
          <Field label="Admin password" required error={errors.admin_password?.message}>
            <Input type="password" placeholder="••••••••" invalid={!!errors.admin_password} {...form.register("admin_password")} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create tenant
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
