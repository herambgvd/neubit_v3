"use client";

// Users & Roles console — USERS view. Three columns (VMS mockup): LEFT a searchable
// library of user cards + New User; CENTER the read-only UserDetail; RIGHT the
// SECURITY POSTURE panel with recovery actions. Create/edit/clone/delete all run
// through modals (same shape as the Roles console); status changes and admin
// actions hit the backend directly from the detail pane.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
  IconButton,
  EmptyPane,
} from "@/components/console";
import { api, apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";
import UserListItem from "./components/UserListItem";
import UserDetail from "./components/UserDetail";
import UserPosture from "./components/UserPosture";
import AddUserModal from "./components/AddUserModal";
import EditUserModal from "./components/EditUserModal";
import DeleteUserModal from "./components/DeleteUserModal";
import CloneUserModal from "./components/CloneUserModal";

const EMPTY_CREATE = { email: "", password: "", full_name: "", role_id: "", send_invite: true, site_ids: [] };
const EMPTY_CLONE = { email: "", full_name: "", send_invite: true };
// `password` is write-only and starts blank on every open: blank = leave it alone.
const EMPTY_EDIT = { full_name: "", email: "", password: "", role_id: "", site_ids: [], is_active: true };

export default function UsersPage() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const canManage = can("user.manage");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CREATE);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [deleting, setDeleting] = useState(null);
  const [delPassword, setDelPassword] = useState("");
  const [cloning, setCloning] = useState(null);
  const [cloneForm, setCloneForm] = useState(EMPTY_CLONE);
  const [busyAction, setBusyAction] = useState(null);
  const importRef = useRef(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);

  async function exportUsers() {
    try {
      const res = await api.get("/auth/users/export", { responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "users.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(apiError(e));
    }
  }

  const importUsers = useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post("/auth/users/import", fd).then((r) => r.data);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(`Imported ${r.created} user(s)${r.skipped ? `, ${r.skipped} skipped` : ""}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function onPickImport(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) importUsers.mutate(file);
  }

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get("/auth/users", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roleOptions = (roles.data?.items || []).map((r) => ({ value: r.id, label: r.name }));
  const sitesQ = useQuery({
    queryKey: ["sites", "scope-picker"],
    queryFn: () => sitesApi.list({ page_size: 200 }),
    staleTime: 60_000,
  });
  const siteList = useMemo(() => {
    const d = sitesQ.data;
    const arr = Array.isArray(d) ? d : d?.items || [];
    return arr.map((s) => ({ site_id: s.site_id, name: s.name }));
  }, [sitesQ.data]);
  // Effective session-idle timeout (tenant policy) for the editor's read-only field.
  const policyQ = useQuery({
    queryKey: ["security-policy"],
    queryFn: () => api.get("/security/policy").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });
  const sessionIdle = policyQ.data?.session_idle_minutes || 0;

  const items = users.data?.items || [];
  const total = users.data?.total ?? items.length;
  const activeCount = items.filter((u) => u.is_active).length;

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    if (!f) return items;
    return items.filter((u) =>
      [u.full_name, u.email, u.role?.name].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [items, search]);

  const selected = useMemo(() => items.find((u) => u.id === selectedId) || null, [items, selectedId]);
  useEffect(() => {
    if (!selected && filtered.length > 0) setSelectedId(filtered[0].id);
  }, [selected, filtered]);

  const create = useMutation({
    mutationFn: (body) => api.post("/auth/users", body),
    onSuccess: () => {
      toast.success("User created");
      qc.invalidateQueries({ queryKey: ["users"] });
      setOpen(false);
      setForm(EMPTY_CREATE);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  // `close` is a UI-only flag (the edit modal wants to dismiss on success) — it is
  // destructured out so it never reaches the PATCH body. An empty `password` means
  // "keep the current one", so it is dropped rather than sent as "".
  const saveEdit = useMutation({
    mutationFn: ({ id, close: _close, ...body }) => {
      if (!body.password) delete body.password;
      return api.patch(`/auth/users/${id}`, body);
    },
    onMutate: () => setBusyAction("save"),
    onSuccess: (_d, vars) => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
      if (vars.close) closeEdit();
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => setBusyAction(null),
  });
  const remove = useMutation({
    mutationFn: ({ id, password }) => api.delete(`/auth/users/${id}`, { data: { password } }),
    onSuccess: (_d, vars) => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["users"] });
      if (selectedId === vars.id) setSelectedId(null);
      setDeleting(null);
      setDelPassword("");
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const adminAction = useMutation({
    mutationFn: ({ id, action }) => api.post(`/auth/users/${id}/${action}`),
    onMutate: ({ key }) => setBusyAction(key),
    onSuccess: (_d, vars) => {
      toast.success(vars.done);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => setBusyAction(null),
  });
  const clone = useMutation({
    mutationFn: ({ id, ...body }) => api.post(`/auth/users/${id}/clone`, body),
    onSuccess: () => {
      toast.success("User cloned");
      qc.invalidateQueries({ queryKey: ["users"] });
      setCloning(null);
      setCloneForm(EMPTY_CLONE);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function openEdit(u) {
    setEditForm({
      full_name: u.full_name || "",
      email: u.email || "",
      password: "",
      role_id: u.role?.id || "",
      site_ids: u.site_ids || [],
      is_active: !!u.is_active,
    });
    setEditing(u);
  }
  function closeEdit() {
    setEditing(null);
    setEditForm(EMPTY_EDIT);
  }
  function openClone(u) {
    setCloneForm({ ...EMPTY_CLONE, full_name: `${u.full_name || u.email} (copy)` });
    setCloning(u);
  }
  // Account-status segment → the right backend action.
  function setStatus(u, next) {
    const cur = u.locked ? "locked" : u.is_active ? "active" : "disabled";
    if (next === cur) return;
    // Never let the signed-in admin lock themselves out of their own console,
    // and never let an Administrator account (the way back in) be shut off.
    if (u.id === me?.id && next !== "active") {
      toast.error("You cannot disable or lock your own account");
      return;
    }
    if (u.role?.is_system && next !== "active") {
      toast.error("Administrator accounts cannot be disabled or locked");
      return;
    }
    if (next === "locked") {
      adminAction.mutate({ id: u.id, action: "lock", key: "lock", done: "Account locked" });
    } else if (next === "active") {
      if (u.locked) adminAction.mutate({ id: u.id, action: "unlock", key: "unlock", done: "Account unlocked" });
      if (!u.is_active) saveEdit.mutate({ id: u.id, is_active: true });
    } else if (next === "disabled") {
      saveEdit.mutate({ id: u.id, is_active: false });
    }
  }

  return (
    <ConsolePage>
      <ConsoleGrid cols="lg:grid-cols-[300px_1fr_320px]">
        {/* LEFT — library */}
        <ConsolePanel>
          <PanelHeader icon="heroicons-outline:user" title="Users" count={total}>
            <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPickImport} />
            <IconButton icon="heroicons-outline:arrow-down-tray" title="Export CSV" onClick={exportUsers} />
            {canManage && (
              <IconButton
                icon={importUsers.isPending ? "svg-spinners:180-ring" : "heroicons-outline:arrow-up-tray"}
                title="Import CSV"
                onClick={() => importRef.current?.click()}
                disabled={importUsers.isPending}
              />
            )}
          </PanelHeader>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search users, email, role…" />

          <PanelList
            loading={users.isLoading}
            empty={filtered.length === 0}
            emptyText={search.trim() ? "No users match your search" : "No users yet"}
          >
            {filtered.map((u) => (
              <UserListItem key={u.id} user={u} selected={u.id === selectedId} onSelect={() => setSelectedId(u.id)} />
            ))}
          </PanelList>

          <PanelFooter>
            {canManage && <CreateButton label="USER" onClick={() => setOpen(true)} />}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              Access is <b className="text-nb-blueb">role-based</b>: users inherit a role&rsquo;s
              permissions, scoped by site. Every change is audit-signed for IS 19319 evidence.
            </p>
          </PanelFooter>
        </ConsolePanel>

        {/* CENTER — editor */}
        <ConsolePanel>
          {selected ? (
            <UserDetail
              key={selected.id}
              user={selected}
              canManage={canManage}
              isSelf={selected.id === me?.id}
              sites={siteList}
              sessionIdleMinutes={sessionIdle}
              onEdit={() => openEdit(selected)}
              onDelete={() => setDeleting(selected)}
              onSetStatus={(s) => setStatus(selected, s)}
              onResetMfa={() => adminAction.mutate({ id: selected.id, action: "reset-mfa", key: "resetmfa", done: "MFA reset" })}
            />
          ) : (
            <EmptyPane
              icon="heroicons-outline:users"
              title="No user selected"
              subtitle="Pick one from the list, or click ＋ NEW USER to create an account."
            />
          )}
        </ConsolePanel>

        {/* RIGHT — posture */}
        <ConsolePanel className="hidden lg:flex">
          {selected ? (
            <UserPosture
              key={selected.id}
              user={selected}
              canManage={canManage}
              busyAction={busyAction}
              onClone={() => openClone(selected)}
              onForceSignOut={() => adminAction.mutate({ id: selected.id, action: "revoke-sessions", key: "revoke", done: "Signed out everywhere" })}
              onUnlock={() => adminAction.mutate({ id: selected.id, action: "unlock", key: "unlock", done: "Account unlocked" })}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-4 text-center text-xs text-nb-faint">
              Select a user to see their security posture.
            </div>
          )}
        </ConsolePanel>
      </ConsoleGrid>

      <AddUserModal
        open={open}
        onClose={() => setOpen(false)}
        form={form}
        setForm={setForm}
        roleOptions={roleOptions}
        sites={siteList}
        onCreate={() => create.mutate(form)}
        creating={create.isPending}
      />
      <EditUserModal
        editing={editing}
        isSelf={editing?.id === me?.id}
        onClose={closeEdit}
        form={editForm}
        setForm={setEditForm}
        roleOptions={roleOptions}
        sites={siteList}
        onSave={() => saveEdit.mutate({ id: editing.id, ...editForm, close: true })}
        saving={saveEdit.isPending}
      />
      <CloneUserModal
        source={cloning}
        onClose={() => { setCloning(null); setCloneForm(EMPTY_CLONE); }}
        form={cloneForm}
        setForm={setCloneForm}
        onClone={() => clone.mutate({ id: cloning.id, ...cloneForm })}
        cloning={clone.isPending}
      />
      <DeleteUserModal
        deleting={deleting}
        onClose={() => { setDeleting(null); setDelPassword(""); }}
        password={delPassword}
        setPassword={setDelPassword}
        onConfirm={() => remove.mutate({ id: deleting.id, password: delPassword })}
        removing={remove.isPending}
      />
    </ConsolePage>
  );
}
