"use client";

// Users & Roles console — USERS view. Three columns (VMS mockup): LEFT a searchable
// library of user cards + New User; CENTER the inline UserEditor; RIGHT the
// SECURITY POSTURE panel with recovery actions. Create/clone/delete run through
// modals; edits, status changes and admin actions hit the backend directly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Spinner } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { sites as sitesApi } from "@/lib/api/sites";
import { useAuth } from "@/lib/auth";
import UserListItem from "./components/UserListItem";
import UserEditor from "./components/UserEditor";
import UserPosture from "./components/UserPosture";
import AddUserModal from "./components/AddUserModal";
import DeleteUserModal from "./components/DeleteUserModal";
import CloneUserModal from "./components/CloneUserModal";

const EMPTY_CREATE = { email: "", password: "", full_name: "", role_id: "", send_invite: true, site_ids: [] };
const EMPTY_CLONE = { email: "", full_name: "", send_invite: true };

export default function UsersPage() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const canManage = can("user.manage");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CREATE);
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
  const saveEdit = useMutation({
    mutationFn: ({ id, ...body }) => api.patch(`/auth/users/${id}`, body),
    onMutate: () => setBusyAction("save"),
    onSuccess: () => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
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

  function openClone(u) {
    setCloneForm({ ...EMPTY_CLONE, full_name: `${u.full_name || u.email} (copy)` });
    setCloning(u);
  }
  // Account-status segment → the right backend action.
  function setStatus(u, next) {
    const cur = u.locked ? "locked" : u.is_active ? "active" : "disabled";
    if (next === cur) return;
    if (next === "locked") {
      adminAction.mutate({ id: u.id, action: "lock", key: "lock", done: "Account locked" });
    } else if (next === "active") {
      if (u.locked) adminAction.mutate({ id: u.id, action: "unlock", key: "unlock", done: "Account unlocked" });
      if (!u.is_active) saveEdit.mutate({ id: u.id, is_active: true });
    } else if (next === "disabled") {
      saveEdit.mutate({ id: u.id, is_active: false });
    }
  }

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
              <Icon icon="heroicons-outline:user" className="text-sm text-nb-blueb" />
              <span className="text-[11px] font-semibold uppercase tracking-[1.6px] text-nb-muted">Users</span>
              <span className="font-mono text-[11px] text-nb-faint">{total}</span>
            </div>
            <div className="flex items-center gap-1">
              <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPickImport} />
              <button onClick={exportUsers} title="Export CSV" className="grid h-7 w-7 place-items-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb">
                <Icon icon="heroicons-outline:arrow-down-tray" className="text-sm" />
              </button>
              {canManage && (
                <button onClick={() => importRef.current?.click()} disabled={importUsers.isPending} title="Import CSV" className="grid h-7 w-7 place-items-center rounded-[8px] border border-nb-line bg-[rgba(10,18,40,.65)] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb disabled:opacity-50">
                  <Icon icon={importUsers.isPending ? "svg-spinners:180-ring" : "heroicons-outline:arrow-up-tray"} className="text-sm" />
                </button>
              )}
            </div>
          </div>
          <div className="px-3 pb-2">
            <div className="flex items-center gap-2 rounded-[9px] border border-nb-line bg-[rgba(6,11,26,.5)] px-3 py-2">
              <Icon icon="heroicons-outline:magnifying-glass" className="text-sm text-nb-faint" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search users, email, role…"
                className="w-full bg-transparent text-[12.5px] text-nb-muted outline-none placeholder:text-nb-faint"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3">
            {users.isLoading ? (
              <div className="flex items-center gap-2 px-1 py-6 text-sm text-nb-soft"><Spinner className="!h-4 !w-4" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-1 py-10 text-center text-xs text-nb-faint">
                {search.trim() ? "No users match your search" : "No users yet"}
              </div>
            ) : (
              <div className="space-y-2 pb-2">
                {filtered.map((u) => (
                  <UserListItem key={u.id} user={u} selected={u.id === selectedId} onSelect={() => setSelectedId(u.id)} />
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-nb-line/50 p-3">
            {canManage && (
              <button
                onClick={() => setOpen(true)}
                className="w-full rounded-[9px] border border-dashed border-[rgba(150,180,245,.42)] py-2.5 text-[12px] tracking-[.7px] text-nb-muted transition hover:border-nb-blue hover:text-nb-blueb"
              >
                ＋ NEW USER
              </button>
            )}
            <p className="mt-2.5 text-[10.5px] leading-relaxed text-nb-faint">
              Access is <b className="text-nb-blueb">role-based</b>: users inherit a role&rsquo;s
              permissions, scoped by site. Every change is audit-signed for IS 19319 evidence.
            </p>
          </div>
        </div>

        {/* CENTER — editor */}
        <div className={col}>
          {selected ? (
            <UserEditor
              key={selected.id}
              user={selected}
              canManage={canManage}
              isSelf={selected.id === me?.id}
              sites={siteList}
              roleOptions={roleOptions}
              sessionIdleMinutes={sessionIdle}
              busyAction={busyAction}
              onSave={(body) => saveEdit.mutate({ id: selected.id, ...body })}
              onDelete={() => setDeleting(selected)}
              onSetStatus={(s) => setStatus(selected, s)}
              onResetMfa={() => adminAction.mutate({ id: selected.id, action: "reset-mfa", key: "resetmfa", done: "MFA reset" })}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center py-20 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full border border-nb-line bg-[rgba(10,18,40,.6)] text-nb-muted">
                <Icon icon="heroicons-outline:users" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-nb-ink">No user selected</div>
              <div className="mt-0.5 text-xs text-nb-faint">Pick one from the list or create a new account.</div>
            </div>
          )}
        </div>

        {/* RIGHT — posture */}
        <div className={`${col} hidden lg:flex`}>
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
        </div>
      </div>

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
    </div>
  );
}
