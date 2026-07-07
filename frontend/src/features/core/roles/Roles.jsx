"use client";

// Roles & Permissions — table of roles with a create/edit modal that embeds a
// grouped permission picker. System roles are view-only. Thin orchestrator:
// owns queries, mutations, and dialog/form state; delegates the table columns,
// the form modal, and the permission selector to decomposed components.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button, Card, ConfirmDialog, EmptyState, PageHeader, Spinner, Table } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { buildRoleColumns } from "./components/RoleColumns";
import RoleFormModal from "./components/RoleFormModal";

const EMPTY = { name: "", description: "", permissions: [] };

export default function RolesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // the role being edited, or null when creating
  const [form, setForm] = useState(EMPTY);
  const [confirm, setConfirm] = useState(null);

  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const catalog = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api.get("/auth/permissions").then((r) => r.data),
  });
  const groups = catalog.data?.groups || {};

  const readOnly = !!editing?.is_system;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["roles"] });
    setOpen(false);
    setEditing(null);
    setForm(EMPTY);
  };

  const create = useMutation({
    mutationFn: (body) => api.post("/auth/roles", body),
    onSuccess: () => {
      toast.success("Role created");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const patch = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/auth/roles/${id}`, body),
    onSuccess: () => {
      toast.success("Role updated");
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (id) => api.delete(`/auth/roles/${id}`),
    onSuccess: () => {
      toast.success("Role deleted");
      qc.invalidateQueries({ queryKey: ["roles"] });
      setConfirm(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }
  function openEdit(role) {
    setEditing(role);
    setForm({
      name: role.name || "",
      description: role.description || "",
      permissions: [...(role.permissions || [])],
    });
    setOpen(true);
  }
  function handleDelete(role) {
    setConfirm({
      title: "Delete role",
      message: <>Delete role <strong>{role.name}</strong>? This can’t be undone.</>,
      confirmLabel: "Delete role",
      onConfirm: () => remove.mutate(role.id),
    });
  }

  const selected = useMemo(() => new Set(form.permissions), [form.permissions]);

  function toggleKey(key) {
    if (readOnly) return;
    setForm((f) => {
      const next = new Set(f.permissions);
      next.has(key) ? next.delete(key) : next.add(key);
      return { ...f, permissions: [...next] };
    });
  }
  function toggleGroup(perms, checkAll) {
    if (readOnly) return;
    setForm((f) => {
      const next = new Set(f.permissions);
      perms.forEach((p) => (checkAll ? next.add(p.key) : next.delete(p.key)));
      return { ...f, permissions: [...next] };
    });
  }

  function save() {
    const body = { name: form.name, description: form.description, permissions: form.permissions };
    if (editing) patch.mutate({ id: editing.id, ...body });
    else create.mutate(body);
  }

  const saving = create.isPending || patch.isPending;

  const columns = buildRoleColumns({ onEdit: openEdit, onDelete: handleDelete });

  return (
    <div>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Define roles and the exact permissions each one grants."
        actions={<Button variant="success" icon="heroicons-outline:plus" onClick={openCreate}>Create role</Button>}
      />

      <Card className="p-2">
        {roles.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={roles.data?.items}
            empty={
              <EmptyState
                icon="heroicons-outline:shield-check"
                title="No roles yet"
                subtitle="Create your first role to start assigning permissions."
                action={<Button variant="success" icon="heroicons-outline:plus" onClick={openCreate}>Create role</Button>}
              />
            }
          />
        )}
      </Card>

      <RoleFormModal
        open={open}
        onClose={() => setOpen(false)}
        editing={editing}
        readOnly={readOnly}
        form={form}
        setForm={setForm}
        groups={groups}
        selected={selected}
        catalogLoading={catalog.isLoading}
        onToggleKey={toggleKey}
        onToggleGroup={toggleGroup}
        onSave={save}
        saving={saving}
      />

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
