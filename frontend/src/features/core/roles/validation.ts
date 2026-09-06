// Field rules for the Role form + clone dialogs, mirroring users/validation.js.
// Same reason: name the bad field next to the field, instead of letting the API
// answer with a 422 the operator has to decode out of a toast.

/** The role dialog's fields (→ `CreateRoleIn` / `UpdateRoleIn`). */
export interface RoleForm {
  name: string;
  description: string;
  /** Permission keys, e.g. "vms.camera.read". */
  permissions: string[];
}

export type RoleFormErrors = { name?: string };

export function roleNameError(value: string | null | undefined): string | undefined {
  const name = value?.trim() || "";
  if (!name) return "Role name is required.";
  if (name.length < 2) return "Role name is too short.";
  return undefined;
}

export function validateRole(form: Pick<RoleForm, "name">): RoleFormErrors {
  const error = roleNameError(form.name);
  return error ? { name: error } : {};
}
