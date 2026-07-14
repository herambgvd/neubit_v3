"use client";

// Users — master/detail. LEFT: a searchable list of accounts with active/disabled
// counts and Export / Import / Add in the list header. RIGHT: UserDetail for the
// selected account. Add/edit/delete still run through the decomposed modals.
// Mirrors the Sites config layout.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { toast } from "sonner";

import { Spinner } from "@/components/ui/kit";
import { MasterDetail, ListPanel } from "@/components/common";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import UserListItem from "./components/UserListItem";
import UserDetail from "./components/UserDetail";
import AddUserModal from "./components/AddUserModal";
import EditUserModal from "./components/EditUserModal";
import DeleteUserModal from "./components/DeleteUserModal";

const EMPTY_CREATE = { email: "", password: "", full_name: "", role_id: "", send_invite: true };

export default function UsersPage() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const canManage = can("user.manage");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CREATE);
  const [editing, setEditing] = useState(null); // user being edited, or null
  const [editForm, setEditForm] = useState({ full_name: "", role_id: "", is_active: true });
  const [deleting, setDeleting] = useState(null); // user being deleted, or null
  const [delPassword, setDelPassword] = useState("");
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
    onSuccess: () => {
      toast.success("User updated");
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    // DELETE with a confirmation body: the acting admin re-enters their password.
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

  function openEdit(u) {
    setEditForm({ full_name: u.full_name || "", role_id: u.role.id, is_active: u.is_active });
    setEditing(u);
  }

  const listActions = (
    <div className="flex items-center gap-1">
      <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPickImport} />
      <button
        onClick={exportUsers}
        title="Export CSV"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-foreground"
      >
        <Icon icon="heroicons-outline:arrow-down-tray" className="text-sm" />
      </button>
      {canManage && (
        <button
          onClick={() => importRef.current?.click()}
          disabled={importUsers.isPending}
          title="Import CSV"
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-card-border text-muted hover:bg-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon
            icon={importUsers.isPending ? "svg-spinners:180-ring" : "heroicons-outline:arrow-up-tray"}
            className="text-sm"
          />
        </button>
      )}
      {canManage && (
        <button
          onClick={() => setOpen(true)}
          title="Add user"
          className="inline-flex h-7 items-center gap-1 rounded-md bg-emerald-600 px-2 text-[12px] font-medium text-white transition hover:bg-emerald-500"
        >
          <Icon icon="heroicons-mini:plus" className="text-sm" /> Add
        </button>
      )}
    </div>
  );

  return (
    <div>
      <MasterDetail
        aside={
          <ListPanel
            title="Users"
            count={total}
            action={listActions}
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Search name, email or role…"
          >
            <div className="flex items-center gap-3 px-4 pb-1 pt-1 text-xs">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <span className="text-muted">{activeCount} active</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-muted/50" />
                <span className="text-muted">{items.length - activeCount} disabled</span>
              </span>
            </div>

            {users.isLoading ? (
              <div className="px-4 py-8 flex items-center gap-2 text-sm text-muted">
                <Spinner className="!h-4 !w-4" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-hover">
                  <Icon icon="heroicons-outline:users" className="text-lg text-muted" />
                </div>
                <div className="text-sm font-medium text-foreground">
                  {search.trim() ? "No users match your search" : "No users yet"}
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {search.trim() ? "Try a different keyword." : "Click Add to create the first account."}
                </div>
              </div>
            ) : (
              <ul className="divide-y divide-card-border">
                {filtered.map((u) => (
                  <UserListItem
                    key={u.id}
                    user={u}
                    selected={u.id === selectedId}
                    onSelect={() => setSelectedId(u.id)}
                  />
                ))}
              </ul>
            )}
          </ListPanel>
        }
      >
        <section className="rounded-xl border border-card-border bg-card overflow-hidden min-h-0 flex flex-col">
          {selected ? (
            <UserDetail
              key={selected.id}
              user={selected}
              canManage={canManage}
              isSelf={selected.id === me?.id}
              onClose={() => setSelectedId(null)}
              onEdit={() => openEdit(selected)}
              onDelete={() => setDeleting(selected)}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-20">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-hover text-muted">
                <Icon icon="heroicons-outline:users" className="text-xl" />
              </span>
              <div className="mt-3 text-sm font-semibold text-foreground">No user selected</div>
              <div className="text-xs text-muted mt-0.5">
                Pick one from the list, or click <b>Add</b> to create a new account.
              </div>
            </div>
          )}
        </section>
      </MasterDetail>

      <AddUserModal
        open={open}
        onClose={() => setOpen(false)}
        form={form}
        setForm={setForm}
        roleOptions={roleOptions}
        onCreate={() => create.mutate(form)}
        creating={create.isPending}
      />

      <EditUserModal
        editing={editing}
        onClose={() => setEditing(null)}
        form={editForm}
        setForm={setEditForm}
        roleOptions={roleOptions}
        onSave={() => saveEdit.mutate({ id: editing.id, ...editForm })}
        saving={saveEdit.isPending}
      />

      <DeleteUserModal
        deleting={deleting}
        onClose={() => {
          setDeleting(null);
          setDelPassword("");
        }}
        password={delPassword}
        setPassword={setDelPassword}
        onConfirm={() => remove.mutate({ id: deleting.id, password: delPassword })}
        removing={remove.isPending}
      />
    </div>
  );
}
