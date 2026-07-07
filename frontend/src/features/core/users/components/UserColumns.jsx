"use client";

// Column definitions for the users table. Kept as a factory so the row actions
// can close over the page's edit/delete handlers and permission flags.
import { Avatar, Badge, Button } from "@/components/ui/kit";
import { fmtLogin } from "../format";

export function buildUserColumns({ canManage, meId, onEdit, onDelete }) {
  return [
    {
      key: "email",
      label: "User",
      render: (u) => (
        <div className="flex items-center gap-3">
          <Avatar src={u.avatar_url} name={u.full_name || u.email} size={32} />
          <div className="min-w-0">
            <div className="font-medium">{u.full_name || "—"}</div>
            <div className="text-xs text-muted">{u.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: "role",
      label: "Role",
      render: (u) => <span className="font-medium">{u.role?.name || "—"}</span>,
    },
    {
      key: "email_verified",
      label: "Verified",
      render: (u) => (
        <Badge color={u.email_verified ? "green" : "amber"}>
          {u.email_verified ? "Verified" : "Pending"}
        </Badge>
      ),
    },
    {
      key: "last_login_at",
      label: "Last login",
      render: (u) => <span className="text-muted">{fmtLogin(u.last_login_at)}</span>,
    },
    {
      key: "is_active",
      label: "Status",
      render: (u) => (
        <Badge color={u.is_active ? "green" : "slate"}>{u.is_active ? "Active" : "Disabled"}</Badge>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            label: "",
            render: (u) => (
              <div className="flex items-center justify-end gap-1">
                <Button variant="ghost" icon="heroicons-outline:pencil-square" onClick={() => onEdit(u)}>
                  Edit
                </Button>
                {u.id !== meId && (
                  <Button variant="danger" icon="heroicons-outline:trash" onClick={() => onDelete(u)}>
                    Delete
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];
}
