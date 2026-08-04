"use client";

// Roles & Permissions — ROLES view. Three columns matching the Users console: LEFT a
// searchable role-card library + New Role; CENTER RoleDetail (description + granted
// permissions); RIGHT the ROLE SUMMARY panel + Clone. Create/edit run through the
// RoleFormModal (system roles open read-only); clone through a small modal.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Button, ConfirmDialog, Input, Modal, Spinner } from "@/components/ui/kit";
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

  const col = "rounded-[12px] border border-nb-line bg-[rgba(8,15,34,.5)] min-h-0 flex flex-col overflow-hidden";

  return (
    <div
      className="flex h-full min-h-0 flex-col -mx-4 lg:-mx-5 -my-3 px-4 lg:px-5 py-3 text-nb-ink"
      style={{ background: "radial-gradient(1200px 700px at 50% 115%, #14284f 0%, #0c1530 55%)" }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[300px_1fr_320px]">
        {/* LEFT — library */}
        <div className={col}>
          <div className="flex items-center justify-between px-4 pb-2 pt-3.5">
            <div className="flex items-center gap-2">
              <Icon icon="heroicons-outline:shield-check" className="text-sm text-nb-blueb" />
              <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Roles</span>
              <span className="font-mono text-[11px] text-nb-faint">{total}</span>
            </div>
          </div>
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
              <Icon icon="heroicons-outline:magnifying-glass" className="text-sm text-nb-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search roles…"
                className="w-full bg-transparent text-[12.5px] text-nb-muted outline-none placeholder:text-nb-faint"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {roles.isLoading ? (
              <div className="flex items-center gap-2 px-1 py-6 text-sm text-nb-soft"><Spinner className="!h-4 !w-4" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-1 py-10 text-center text-xs text-nb-faint">
                {search.trim() ? "No roles match your search" : "No roles yet"}
              </div>
            ) : (
              <div className="space-y-2 pb-2">
                {filtered.map((r) => (
                  <RoleListItem key={r.id} role={r} selected={r.id === selectedId} onSelect={() => setSelectedId(r.id)} />
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-nb-line/50 p-3">
            {canManage && (
              <button
                onClick={openCreate}
                className="w-full rounded-[9px] border border-dashed border-[rgba(150,180,245,.42)] py-2.5 text-[12px] tracking-[.7px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                ＋ NEW ROLE
              </button>
            )}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              A role is a named <b className="text-nb-blueb">bundle of permissions</b>. Users inherit
              their role&rsquo;s access; every change is audit-signed.
            </p>
          </div>
        </div>

        {/* CENTER — detail */}
        <div className={col}>
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
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
                <Icon icon="heroicons-outline:shield-check" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-nb-ink">No role selected</div>
              <div className="mt-0.5 text-xs text-nb-faint">Pick one from the list or create a new role.</div>
            </div>
          )}
        </div>

        {/* RIGHT — summary */}
        <div className={`${col} hidden lg:flex`}>
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
        </div>
      </div>

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
        title={cloneSrc ? `Clone ${cloneSrc.name}` : "Clone role"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCloneSrc(null)}>Cancel</Button>
            <Button variant="success" disabled={cloneRole.isPending || !cloneName.trim()} onClick={() => cloneRole.mutate({ id: cloneSrc.id, name: cloneName.trim() })}>
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
          <Input label="New role name" value={cloneName} onChange={(e) => setCloneName(e.target.value)} placeholder="Enter new role name (e.g. SOC Operator — night shift)" />
        </div>
      </Modal>

      <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} pending={remove.isPending} />
    </div>
  );
}
