"use client";

// Column definitions for the roles table.
import { Badge, Button } from "@/components/ui/kit";

const permLabel = (role) => {
  const perms = role.permissions || [];
  if (perms.includes("*")) return "All permissions";
  return `${perms.length} permission${perms.length === 1 ? "" : "s"}`;
};

export function buildRoleColumns({ onEdit, onDelete }) {
  return [
    {
      key: "name",
      label: "Role",
      render: (role) => (
        <div>
          <div className="font-medium">{role.name}</div>
          {role.description && <div className="text-xs text-muted line-clamp-1">{role.description}</div>}
        </div>
      ),
    },
    {
      key: "perms",
      label: "Permissions",
      render: (role) => <span className="text-muted">{permLabel(role)}</span>,
    },
    {
      key: "type",
      label: "Type",
      render: (role) => (
        <Badge color={role.is_system ? "indigo" : "slate"}>{role.is_system ? "System" : "Custom"}</Badge>
      ),
    },
    {
      key: "actions",
      label: "",
      render: (role) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" icon="heroicons-outline:pencil-square" onClick={() => onEdit(role)}>
            {role.is_system ? "View" : "Edit"}
          </Button>
          {!role.is_system && (
            <Button variant="danger" icon="heroicons-outline:trash" onClick={() => onDelete(role)}>
              Delete
            </Button>
          )}
        </div>
      ),
    },
  ];
}
