"use client";

// Roles & Permissions — master/detail. LEFT: a searchable role list with system/
// custom counts and Add in the list header. RIGHT: RoleDetail (description + the
// granted permissions grouped by category). Create/edit still run through the
// RoleFormModal (system roles open it read-only). Mirrors the Sites config layout.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { ConfirmDialog, Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel } from "@/components/common";
import { api, apiError } from "@/lib/api";
import RoleListItem from "./components/RoleListItem";
import RoleDetail from "./components/RoleDetail";
import RoleFormModal from "./components/RoleFormModal";

const EMPTY = { name: "", description: "", permissions: [] };

export default function RolesPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null); // the role being edited, or null when creating
  const [form, setForm] = useState(EMPTY);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

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

  const items = roles.data?.items || [];
  const total = roles.data?.total ?? items.length;
  const systemCount = items.filter((r) => r.is_system).length;

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    if (!f) return items;
    return items.filter((r) =>
      [r.name, r.description].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [items, search]);

  const selectedRole = useMemo(() => items.find((r) => r.id === selectedId) || null, [items, selectedId]);

  useEffect(() => {
    if (!selectedRole && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selectedRole, filtered]);

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
    onSuccess: (_d, id) => {
      toast.success("Role deleted");
      qc.invalidateQueries({ queryKey: ["roles"] });
      if (selectedId === id) setSelectedId(null);
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
      message: (
        <>
          Delete role <strong>{role.name}</strong>? This can’t be undone.
        </>
      ),
      confirmLabel: "Delete role",
      onConfirm: () => remove.mutate(role.id),
    });
  }

  const selectedPerms = useMemo(() => new Set(form.permissions), [form.permissions]);

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

  const listActions = (
    <button
      onClick={openCreate}
      title="Create role"
      className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
    >
      <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
    </button>
  );

  return (
    <div>
      <MasterDetail
        aside={
          <ListPanel
            title="Roles"
            count={total}
            action={listActions}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search roles…"
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />
                <span className="text-muted">{systemCount} system</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                <span className="text-muted">{items.length - systemCount} custom</span>
              </span>
            </div>

            {roles.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:shield-check" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {search.trim() ? "No roles match your search" : "No roles yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {search.trim()
                    ? "Try a different keyword."
                    : "Create your first role to start assigning permissions."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((r) => (
                  <RoleListItem
                    key={r.id}
                    role={r}
                    selected={r.id === selectedId}
                    onSelect={() => setSelectedId(r.id)}
                  />
                ))}
              </ul>
            )}
          </ListPanel>
        }
      >
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
          {selectedRole ? (
            <RoleDetail
              key={selectedRole.id}
              role={selectedRole}
              groups={groups}
              catalogLoading={catalog.isLoading}
              onClose={() => setSelectedId(null)}
              onEdit={() => openEdit(selectedRole)}
              onDelete={() => handleDelete(selectedRole)}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:shield-check" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No role selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add</b> to create a new role.
              </div>
            </div>
          )}
        </section>
      </MasterDetail>

      <RoleFormModal
        open={open}
        onClose={() => setOpen(false)}
        editing={editing}
        readOnly={readOnly}
        form={form}
        setForm={setForm}
        groups={groups}
        selected={selectedPerms}
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
