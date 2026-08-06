"use client";

// Roles & Permissions — ROLES view. Three columns matching the Users console: LEFT a
// searchable role-card library + New Role; CENTER RoleDetail (description + granted
// permissions); RIGHT the ROLE SUMMARY panel + Clone. Create/edit run through the
// RoleFormModal (system roles open read-only); clone through a small modal.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelSearch,
  PanelList,
  PanelFooter,
  CreateButton,
  EmptyPane,
} from "@/components/console";
import { Button, ConfirmDialog, Input, Modal } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import RoleListItem from "./components/RoleListItem";
import RoleDetail from "./components/RoleDetail";
import RolePanel from "./components/RolePanel";
import RoleFormModal from "./components/RoleFormModal";

const EMPTY = { name: "", description: "", permissions: [] };

export default function RolesPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const canManage = can("role.manage");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [confirm, setConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [cloneSrc, setCloneSrc] = useState(null);
  const [cloneName, setCloneName] = useState("");

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
    onSuccess: () => { toast.success("Role created"); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const patch = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/auth/roles/${id}`, body),
    onSuccess: () => { toast.success("Role updated"); invalidate(); },
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
  const cloneRole = useMutation({
    mutationFn: ({ id, name }) => api.post(`/auth/roles/${id}/clone`, { name }),
    onSuccess: (res) => {
      toast.success("Role cloned");
      qc.invalidateQueries({ queryKey: ["roles"] });
      setCloneSrc(null);
      setCloneName("");
      if (res?.data?.id) setSelectedId(res.data.id);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function openCreate() { setEditing(null); setForm(EMPTY); setOpen(true); }
  function openEdit(role) {
    setEditing(role);
    setForm({ name: role.name || "", description: role.description || "", permissions: [...(role.permissions || [])] });
    setOpen(true);
  }
  function openClone(role) { setCloneName(`${role.name} (copy)`); setCloneSrc(role); }
  function handleDelete(role) {
    setConfirm({
      title: "Delete role",
      message: (<>Delete role <strong>{role.name}</strong>? This can’t be undone.</>),
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

  return (
    <ConsolePage>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr_320px]">
        {/* LEFT — library */}
        <ConsolePanel>
          <PanelHeader icon="heroicons-outline:shield-check" title="Roles" count={total} />
          <PanelSearch value={search} onChange={setSearch} placeholder="Search roles…" />

          <PanelList
            loading={roles.isLoading}
            empty={filtered.length === 0}
            emptyText={search.trim() ? "No roles match your search" : "No roles yet"}
          >
            {filtered.map((r) => (
              <RoleListItem key={r.id} role={r} selected={r.id === selectedId} onSelect={() => setSelectedId(r.id)} />
            ))}
          </PanelList>

          <PanelFooter>
            {canManage && <CreateButton label="ROLE" onClick={openCreate} />}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              A role is a named <b className="text-nb-blueb">bundle of permissions</b>. Users inherit
              their role&rsquo;s access; every change is audit-signed.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* CENTER — detail */}
        <ConsolePanel>
          {selectedRole ? (
            <RoleDetail
              key={selectedRole.id}
              role={selectedRole}
              groups={groups}
              catalogLoading={catalog.isLoading}
              canManage={canManage}
              onClose={() => setSelectedId(null)}
              onEdit={() => openEdit(selectedRole)}
              onDelete={() => handleDelete(selectedRole)}
              onClone={() => openClone(selectedRole)}
            />
          ) : (
            <EmptyPane
              icon="heroicons-outline:shield-check"
              title="No role selected"
              subtitle="Pick one from the list, or click ＋ NEW ROLE to create a role."
            />
          )}
        </ConsolePanel>

        {/* RIGHT — summary */}
        <ConsolePanel className="hidden lg:flex">
          {selectedRole ? (
            <RolePanel
              key={selectedRole.id}
              role={selectedRole}
              groups={groups}
              canManage={canManage}
              onClone={() => openClone(selectedRole)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-nb-faint">
              Select a role to see its summary.
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>

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

      <Modal
        open={!!cloneSrc}
        onClose={() => setCloneSrc(null)}
        staticBackdrop
        title={cloneSrc ? `Clone ${cloneSrc.name}` : "Clone role"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCloneSrc(null)}>Cancel</Button>
            <Button variant="action" disabled={cloneRole.isPending || !cloneName.trim()} onClick={() => cloneRole.mutate({ id: cloneSrc.id, name: cloneName.trim() })}>
              {cloneRole.isPending ? "Cloning…" : "Create clone"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-[9px] border border-[rgba(96,165,250,.35)] bg-[rgba(96,165,250,.07)] px-3 py-2.5 text-xs text-nb-soft">
            Copies all of <b className="text-nb-blueb">{cloneSrc?.name}</b>&rsquo;s permissions under a
            new name — a fast starting point you can then trim down.
          </div>
          <Input label="New role name" required value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="Enter new role name (e.g. SOC Operator — night shift)" />
        </div>
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} staticBackdrop />
    </ConsolePage>
  );
}
