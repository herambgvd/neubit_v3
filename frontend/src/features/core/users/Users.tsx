"use client";

// Users & Roles console — USERS view. Three columns (VMS mockup): LEFT a searchable
// library of user cards + New User; CENTER the read-only UserDetail; RIGHT the
// SECURITY POSTURE panel with recovery actions. Create/edit/clone/delete all run
// through modals (same shape as the Roles console); status changes and admin
// actions hit the backend directly from the detail pane.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { toast } from "sonner";

import {
  ConsolePage,
  ConsoleGrid,
  ConsolePanel,
  PanelHeader,
  PanelSearch,
  PanelList,
  IconButton,
  EmptyPane,
} from "@/components/console";
import { api, apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";
import type { Page } from "@/lib/types";
import type { RoleOut, SecurityPolicyOut, UpdateUserIn, UserImportResult, UserOut } from "../types";
import UserListItem from "./components/UserListItem";
import UserDetail, { type AccountStatus } from "./components/UserDetail";
import UserPosture from "./components/UserPosture";
import AddUserModal from "./components/AddUserModal";
import EditUserModal from "./components/EditUserModal";
import DeleteUserModal from "./components/DeleteUserModal";
import CloneUserModal from "./components/CloneUserModal";
import type { CloneUserForm, EditUserForm, NewUserForm } from "./validation";

const EMPTY_CREATE: NewUserForm = { email: "", password: "", full_name: "", role_id: "", send_invite: true, site_ids: [] };
const EMPTY_CLONE: CloneUserForm = { email: "", full_name: "", send_invite: true };
// `password` is write-only and starts blank on every open: blank = leave it alone.
const EMPTY_EDIT: EditUserForm = { full_name: "", email: "", password: "", role_id: "", site_ids: [], is_active: true };

/** A PATCH plus the UI-only `close` flag (see saveEdit). */
type SaveEditVars = UpdateUserIn & { id: string; close?: boolean };

/** One of the POST /auth/users/{id}/{action} admin actions. `key` names the
 *  busy state for the button that fired it; `done` is the success toast. */
interface AdminActionVars {
  id: string;
  action: "lock" | "unlock" | "reset-mfa" | "revoke-sessions";
  key: string;
  done: string;
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const canManage = can("user.manage");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CREATE);
  const [editing, setEditing] = useState<UserOut | null>(null);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [deleting, setDeleting] = useState<UserOut | null>(null);
  const [delPassword, setDelPassword] = useState("");
  const [cloning, setCloning] = useState<UserOut | null>(null);
  const [cloneForm, setCloneForm] = useState(EMPTY_CLONE);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.post<UserImportResult>("/auth/users/import", fd).then((r) => r.data);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      toast.success(`Imported ${r.created} user(s)${r.skipped ? `, ${r.skipped} skipped` : ""}`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function onPickImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) importUsers.mutate(file);
  }

  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => api.get<Page<UserOut>>("/auth/users", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roles = useQuery({
    queryKey: ["roles"],
    queryFn: () => api.get<Page<RoleOut>>("/auth/roles", { params: { page_size: 100 } }).then((r) => r.data),
  });
  const roleOptions = (roles.data?.items || []).map((r) => ({ value: r.id, label: r.name }));
  const sitesQ = useQuery({
    queryKey: ["sites", "scope-picker"],
    queryFn: () => sitesApi.list({ page_size: 200 }),
    staleTime: 60_000,
  });
  const siteList = useMemo(
    () => (sitesQ.data?.items || []).map((s) => ({ site_id: s.site_id, name: s.name })),
    [sitesQ.data],
  );
  // Effective session-idle timeout (tenant policy) for the editor's read-only field.
  const policyQ = useQuery({
    queryKey: ["security-policy"],
    queryFn: () => api.get<SecurityPolicyOut>("/security/policy").then((r) => r.data),
    staleTime: 60_000,
    retry: false,
  });
  const sessionIdle = policyQ.data?.session_idle_minutes || 0;

  const items = useMemo(() => users.data?.items ?? [], [users.data]);
  const total = users.data?.total ?? items.length;

  const filtered = useMemo(() => {
    const f = search.trim().toLowerCase();
    if (!f) return items;
    return items.filter((u) =>
      [u.full_name, u.email, u.role?.name].filter(Boolean).join(" ").toLowerCase().includes(f),
    );
  }, [items, search]);

  // The explicit choice, or the first row when there is none. Derived here
  // rather than synced by an effect, which rendered one frame with nothing
  // selected before correcting itself.
  const effectiveId = selectedId ?? filtered[0]?.id ?? null;

  const selected = useMemo(() => items.find((u) => u.id === effectiveId) || null, [items, effectiveId]);

  const create = useMutation({
    mutationFn: (body: NewUserForm) => api.post("/auth/users", body),
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
    mutationFn: ({ id, close: _close, ...body }: SaveEditVars) => {
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
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.delete(`/auth/users/${id}`, { data: { password } }),
    onSuccess: (_d, vars) => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["users"] });
      if (effectiveId === vars.id) setSelectedId(null);
      setDeleting(null);
      setDelPassword("");
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const adminAction = useMutation({
    mutationFn: ({ id, action }: AdminActionVars) => api.post(`/auth/users/${id}/${action}`),
    onMutate: ({ key }) => setBusyAction(key),
    onSuccess: (_d, vars) => {
      toast.success(vars.done);
      qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => setBusyAction(null),
  });
  const clone = useMutation({
    mutationFn: ({ id, ...body }: CloneUserForm & { id: string }) => api.post(`/auth/users/${id}/clone`, body),
    onSuccess: () => {
      toast.success("User cloned");
      qc.invalidateQueries({ queryKey: ["users"] });
      setCloning(null);
      setCloneForm(EMPTY_CLONE);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function openEdit(u: UserOut) {
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
  function openClone(u: UserOut) {
    setCloneForm({ ...EMPTY_CLONE, full_name: `${u.full_name || u.email} (copy)` });
    setCloning(u);
  }
  // Account-status segment → the right backend action.
  function setStatus(u: UserOut, next: AccountStatus) {
    const cur: AccountStatus = u.locked ? "locked" : u.is_active ? "active" : "disabled";
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
            {/* The only way to start a user now the footer button is gone, so its
                title — which IconButton also uses as the aria-label — has to name
                the action rather than leave a screen reader with a bare "+". */}
            {canManage && (
              <IconButton icon="heroicons:plus" title="New user" onClick={() => setOpen(true)} />
            )}
          </PanelHeader>
          <PanelSearch value={search} onChange={setSearch} placeholder="Search users, email, role…" />

          <PanelList
            loading={users.isLoading}
            // A failed load must never read as "no users yet" — that is the same
            // screen an empty directory shows, and it invites the wrong action.
            error={users.isError ? apiError(users.error, "Couldn't load users") : undefined}
            empty={filtered.length === 0}
            emptyText={search.trim() ? "No users match your search" : "No users yet"}
          >
            {filtered.map((u) => (
              <UserListItem key={u.id} user={u} selected={u.id === effectiveId} onSelect={() => setSelectedId(u.id)} />
            ))}
          </PanelList>

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
              subtitle="Pick one from the list, or use ＋ New user at the top of it."
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
        onSave={() => editing && saveEdit.mutate({ id: editing.id, ...editForm, close: true })}
        saving={saveEdit.isPending}
      />
      <CloneUserModal
        source={cloning}
        onClose={() => { setCloning(null); setCloneForm(EMPTY_CLONE); }}
        form={cloneForm}
        setForm={setCloneForm}
        onClone={() => cloning && clone.mutate({ id: cloning.id, ...cloneForm })}
        cloning={clone.isPending}
      />
      <DeleteUserModal
        deleting={deleting}
        onClose={() => { setDeleting(null); setDelPassword(""); }}
        password={delPassword}
        setPassword={setDelPassword}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id, password: delPassword })}
        removing={remove.isPending}
      />
    </ConsolePage>
  );
}
