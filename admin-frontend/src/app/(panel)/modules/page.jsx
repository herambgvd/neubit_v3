"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Lock, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import * as yup from "yup";

import { adminApi, apiError } from "@/lib/api";
import { useAdminForm } from "@/lib/useAdminForm";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  PageHeader,
  Switch,
  Textarea,
} from "@/components/ui";

function normalize(res) {
  const rows = res?.items ?? res;
  return Array.isArray(rows) ? rows : [];
}

export default function ModulesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ["modules"],
    queryFn: () => adminApi.listModules(),
  });

  const modules = normalize(data);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return modules;
    return modules.filter(
      (m) =>
        (m.key || "").toLowerCase().includes(needle) ||
        (m.name || "").toLowerCase().includes(needle) ||
        (m.category || "").toLowerCase().includes(needle)
    );
  }, [modules, q]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["modules"] });

  const del = useMutation({
    mutationFn: (key) => adminApi.deleteModule(key),
    onSuccess: () => {
      toast.success("Module deleted");
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(apiError(err, "Could not delete module")),
  });

  const columns = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Module",
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div>
              <div className="font-medium text-foreground">{m.name || m.key}</div>
              <div className="font-mono text-xs text-muted">{m.key}</div>
              {m.description && <div className="mt-0.5 max-w-md text-xs text-muted">{m.description}</div>}
            </div>
          );
        },
      },
      {
        accessorKey: "category",
        header: "Category",
        cell: ({ row }) =>
          row.original.category ? (
            <Badge tone="foreground" className="capitalize">
              {row.original.category}
            </Badge>
          ) : (
            <span className="text-muted">—</span>
          ),
      },
      {
        accessorKey: "default_enabled",
        header: "Default",
        cell: ({ row }) =>
          row.original.default_enabled ? (
            <Badge tone="success" dot>
              On
            </Badge>
          ) : (
            <Badge tone="neutral" dot>
              Off
            </Badge>
          ),
      },
      {
        accessorKey: "is_system",
        header: "Type",
        cell: ({ row }) =>
          row.original.is_system ? (
            <Badge tone="accent">
              <Lock className="h-3 w-3" />
              System
            </Badge>
          ) : (
            <Badge tone="neutral">Custom</Badge>
          ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        cell: ({ row }) => {
          const m = row.original;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button variant="outline" size="icon" title="Edit" aria-label="Edit" onClick={() => setEditing(m)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                title={m.is_system ? "System modules can't be deleted" : "Delete"}
                aria-label="Delete"
                disabled={m.is_system}
                onClick={() => setDeleting(m)}
                className="hover:border-danger/40 hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          );
        },
      },
    ],
    []
  );

  const toolbar = (
    <div className="relative min-w-[220px] flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search key, name or category…" className="pl-9" />
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Modules"
        description="The feature catalog every tenant inherits. Toggle defaults or add new capabilities."
        actions={
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            Add module
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={filtered}
        loading={isLoading}
        error={isError ? apiError(error, "Failed to load modules") : null}
        toolbar={toolbar}
        empty={{
          icon: Blocks,
          title: q ? "No matching modules" : "No modules yet",
          description: q ? "Try a different search." : "Add your first module.",
        }}
      />

      <div className="mt-4 text-xs text-muted">
        {modules.length} module{modules.length === 1 ? "" : "s"}
        {isFetching ? " · updating…" : ""}
      </div>

      <ModuleModal
        open={showCreate}
        onOpenChange={setShowCreate}
        onSaved={() => {
          setShowCreate(false);
          invalidate();
        }}
      />
      <ModuleModal
        key={editing?.key || "edit"}
        module={editing}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => {
          setEditing(null);
          invalidate();
        }}
      />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete module?"
        description={deleting ? `“${deleting.name || deleting.key}” will be removed from the catalog.` : ""}
        confirmLabel="Delete"
        loading={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting.key)}
      />
    </div>
  );
}

const moduleSchema = yup.object({
  key: yup.string().trim().required("Key is required"),
  name: yup.string().trim().required("Name is required"),
  category: yup.string().trim(),
  description: yup.string().trim(),
});

function ModuleModal({ module, open, onOpenChange, onSaved }) {
  const isEdit = !!module;
  const form = useAdminForm(moduleSchema, {
    key: module?.key || "",
    name: module?.name || "",
    category: module?.category || "",
    description: module?.description || "",
  });
  const { errors } = form.formState;
  const [defaultEnabled, setDefaultEnabled] = useState(module?.default_enabled ?? true);

  const save = useMutation({
    mutationFn: (values) => {
      const body = {
        name: values.name.trim(),
        description: values.description?.trim() || "",
        category: values.category?.trim() || "",
        default_enabled: defaultEnabled,
      };
      if (isEdit) return adminApi.updateModule(module.key, body);
      return adminApi.createModule({ key: values.key.trim(), ...body });
    },
    onSuccess: () => {
      toast.success(isEdit ? "Module updated" : "Module created");
      form.reset();
      onSaved();
    },
    onError: (err) => toast.error(apiError(err, "Could not save module")),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) form.reset(); onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader
          title={isEdit ? "Edit module" : "Add module"}
          description={isEdit ? "Update this platform feature." : "Register a new platform feature."}
        />
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-4" noValidate>
          <Field label="Key" required error={errors.key?.message}>
            <Input
              placeholder="video_analytics"
              autoFocus={!isEdit}
              disabled={isEdit}
              invalid={!!errors.key}
              className={isEdit ? "opacity-60" : ""}
              {...form.register("key")}
            />
          </Field>
          <Field label="Name" required error={errors.name?.message}>
            <Input placeholder="Video Analytics" autoFocus={isEdit} invalid={!!errors.name} {...form.register("name")} />
          </Field>
          <Field label="Category" error={errors.category?.message}>
            <Input placeholder="analytics" {...form.register("category")} />
          </Field>
          <Field label="Description" error={errors.description?.message}>
            <Textarea placeholder="What this module does…" rows={3} {...form.register("description")} />
          </Field>
          <label className="flex cursor-pointer items-center justify-between rounded-lg border border-card-border bg-card px-3.5 py-3">
            <div>
              <div className="text-sm font-medium text-foreground">Enabled by default</div>
              <div className="text-xs text-muted">New tenants inherit this state.</div>
            </div>
            <Switch checked={defaultEnabled} onCheckedChange={setDefaultEnabled} />
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {isEdit ? "Save changes" : "Add module"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
