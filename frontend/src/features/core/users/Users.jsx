"use client";

// Users — table of platform accounts with add/edit/delete + CSV import/export.
// Thin orchestrator: owns the queries, mutations, and dialog state; delegates
// the table columns and each modal to decomposed components.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button, Card, PageHeader, Spinner, Table } from "@/components/ui/kit";
import { api, apiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildUserColumns } from "./components/UserColumns";
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
    onSuccess: () => {
      toast.success("User deleted");
      qc.invalidateQueries({ queryKey: ["users"] });
      setDeleting(null);
      setDelPassword("");
    },
    onError: (e) => toast.error(apiError(e)),
  });

  function openEdit(u) {
    setEditForm({ full_name: u.full_name || "", role_id: u.role.id, is_active: u.is_active });
    setEditing(u);
  }

  const columns = buildUserColumns({ canManage, meId: me?.id, onEdit: openEdit, onDelete: setDeleting });

  return (
    <div>
      <PageHeader
        title="Users"
        subtitle="Manage who can access the platform and their roles."
        actions={
          <div className="flex items-center gap-2">
            <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onPickImport} />
            <Button variant="secondary" icon="heroicons-outline:arrow-down-tray" onClick={exportUsers}>
              Export
            </Button>
            {canManage && (
              <Button
                variant="secondary"
                icon="heroicons-outline:arrow-up-tray"
                disabled={importUsers.isPending}
                onClick={() => importRef.current?.click()}
              >
                {importUsers.isPending ? "Importing…" : "Import"}
              </Button>
            )}
            {canManage && (
              <Button variant="success" icon="heroicons-outline:plus" onClick={() => setOpen(true)}>
                Add user
              </Button>
            )}
          </div>
        }
      />
      <Card className="p-2">
        {users.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <Table columns={columns} rows={users.data?.items} />
        )}
      </Card>

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
